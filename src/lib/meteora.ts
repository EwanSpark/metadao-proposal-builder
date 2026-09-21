/**
 * Meteora DAMM v2 positions held by a DAO treasury, and how to withdraw them by proposal.
 *
 * Every MetaDAO launchpad DAO ends up with one of these: the launch seeds a DAMM v2 pool
 * and the treasury vault holds the position NFT. Unlike Omnipair, DAMM v2 has no
 * top-level-only guard on `remove_all_liquidity` (its account list carries no
 * instructions sysvar), so the treasury can withdraw through a proposal — the same way
 * MetaDAO's own fee crank claims from it via CPI.
 *
 * Account layouts are read at fixed offsets rather than through the on-chain IDL, to keep
 * zlib out of the browser bundle. The offsets were measured against live accounts
 * (position 3HEZS4dR…, pool 6taTMkvd…, program cp_amm, 2026-09-15) and every read is
 * cross-checked against the DAO's own mints so a layout change fails loudly, not silently.
 */
import {
  AccountLayout,
  MintLayout,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import type { Connection } from "@solana/web3.js";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import type { DaoView } from "./futarchy";

export const DAMM_V2_PROGRAM_ID = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
/** Fixed pool authority PDA of DAMM v2 (SDK constant DAMM_V2_POOL_AUTHORITY). */
const POOL_AUTHORITY = new PublicKey("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");

/** sha256("account:Position")[0..8] / sha256("account:Pool")[0..8] / sha256("global:remove_all_liquidity")[0..8] */
const POSITION_DISC = "aabc8fe47a40f7d0";
const POOL_DISC = "f19a6d0411b16dbc";
const REMOVE_ALL_LIQUIDITY_DISC = Buffer.from("0a333d2370691855", "hex");

// Position (408 bytes)
const POS_POOL = 8;
const POS_NFT_MINT = 40;
const POS_UNLOCKED_LIQUIDITY = 152; // u128 LE
// Pool (1112 bytes)
const POOL_TOKEN_A_MINT = 168;
const POOL_TOKEN_B_MINT = 200;
const POOL_TOKEN_A_VAULT = 232;
const POOL_TOKEN_B_VAULT = 264;
const POOL_LIQUIDITY = 360; // u128 LE

export type MeteoraPosition = {
  position: PublicKey;
  pool: PublicKey;
  nftMint: PublicKey;
  /**
   * The token account that actually holds the position NFT. Meteora creates this
   * account itself and it is NOT the treasury's associated token account — deriving the
   * ATA gives an address that holds nothing, and `remove_all_liquidity` fails on it.
   */
  nftAccount: PublicKey;
  tokenAMint: PublicKey;
  tokenBMint: PublicKey;
  tokenAVault: PublicKey;
  tokenBVault: PublicKey;
  tokenAProgram: PublicKey;
  tokenBProgram: PublicKey;
  tokenADecimals: number;
  tokenBDecimals: number;
  /** This position's unlocked liquidity over the pool's total. 1 = the whole pool. */
  share: number;
  /** What a full withdrawal would return right now, in ui units. Moves with every swap. */
  expectedA: number;
  expectedB: number;
  /** Symbols resolved against the DAO: "base", "quote", or the mint prefix. */
  labelA: string;
  labelB: string;
};

/**
 * Public RPCs answer 429 and the odd 500 under a burst of reads; the scan issues
 * several at once. Three tries with a short backoff turn a flaky endpoint into a
 * slow one, which is the only failure mode worth surfacing to the user.
 */
async function getInfo(connection: Connection, key: PublicKey) {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      return await connection.getAccountInfo(key);
    } catch (e: any) {
      last = e;
      if (!/429|5\d\d|Too Many|Internal Server/i.test(String(e?.message))) throw e;
      await new Promise((r) => setTimeout(r, 400 * 2 ** i));
    }
  }
  throw last;
}

const pk = (buf: Buffer, off: number) => new PublicKey(buf.subarray(off, off + 32));
const u128 = (buf: Buffer, off: number) => new BN(buf.subarray(off, off + 16), "le");

/**
 * Every DAMM v2 position whose NFT sits in the treasury vault. Position NFTs are
 * Token-2022 mints with 0 decimals and supply 1; each maps to a `["position", nft_mint]`
 * PDA under the DAMM program.
 */
export async function findMeteoraPositions(
  connection: Connection,
  dao: DaoView,
  /**
   * Skip the treasury scan and resolve these directly. Each entry may be a position
   * account or its NFT mint. Needed on RPCs that refuse indexed calls
   * (getTokenAccountsByOwner) — publicnode does — where the scan cannot run at all.
   */
  explicit?: PublicKey[],
): Promise<MeteoraPosition[]> {
  // (nft mint, token account holding it). The account is what the instruction needs.
  let holdings: { nftMint: PublicKey; nftAccount: PublicKey }[];
  if (explicit?.length) {
    holdings = [];
    for (const key of explicit) {
      // Raw bytes only: `jsonParsed` is itself an "indexed request" on some public RPCs
      // (publicnode returns 403 for it), so nothing here may depend on server-side parsing.
      const v = await getInfo(connection, key);
      const raw = v?.data as Buffer | undefined;

      // 1 · The NFT's token account itself — the path that works on every RPC. Both SPL
      //     Token and Token-2022 accounts start with the same 165-byte layout
      //     (mint, owner, amount…); extensions only follow it.
      const isTokenAccount =
        !!v && Buffer.isBuffer(raw) && raw.length >= AccountLayout.span &&
        (v.owner.equals(TOKEN_PROGRAM_ID) || v.owner.equals(TOKEN_2022_PROGRAM_ID));
      if (isTokenAccount) {
        const acc = AccountLayout.decode(raw!.subarray(0, AccountLayout.span));
        if (acc.amount !== 1n) throw new Error("That token account does not hold exactly one token — not a position NFT.");
        if (!acc.owner.equals(dao.treasury)) {
          throw new Error(`That token account belongs to ${acc.owner.toBase58().slice(0, 8)}…, not to the treasury.`);
        }
        holdings.push({ nftMint: acc.mint, nftAccount: key });
        continue;
      }

      // 2 · A position account, or 3 · the NFT mint. Both still need the holder, and
      //     finding it is an indexed query some RPCs refuse.
      const isPosition =
        v?.owner.equals(DAMM_V2_PROGRAM_ID) &&
        Buffer.isBuffer(raw) &&
        raw.subarray(0, 8).toString("hex") === POSITION_DISC;
      const nftMint = isPosition ? pk(raw as Buffer, POS_NFT_MINT) : key;
      let holder: PublicKey;
      try {
        const largest = await connection.getTokenLargestAccounts(nftMint);
        const h = largest.value.find((x) => x.uiAmount === 1);
        if (!h) throw new Error(`No account holds NFT ${nftMint.toBase58().slice(0, 8)}… — not a position NFT?`);
        holder = h.address;
      } catch (e: any) {
        if (/Indexed requests|403/i.test(String(e?.message))) {
          throw new Error(
            "This RPC refuses indexed queries, so the NFT's holder cannot be looked up. " +
              "Paste the NFT's token account address instead (the treasury's holdings in an explorer), " +
              "or set a full RPC in RPC_URL.",
          );
        }
        throw e;
      }
      const holderInfo = await getInfo(connection, holder);
      const holderAcc = AccountLayout.decode((holderInfo!.data as Buffer).subarray(0, AccountLayout.span));
      if (!holderAcc.owner.equals(dao.treasury)) {
        throw new Error(`The treasury does not hold the position NFT ${nftMint.toBase58().slice(0, 8)}… (held by ${holderAcc.owner.toBase58().slice(0, 8)}…).`);
      }
      holdings.push({ nftMint, nftAccount: holder });
    }
  } else {
    const held = await connection.getParsedTokenAccountsByOwner(dao.treasury, {
      programId: TOKEN_2022_PROGRAM_ID,
    });
    holdings = held.value
      .filter((t) => t.account.data.parsed.info.tokenAmount.decimals === 0 && t.account.data.parsed.info.tokenAmount.uiAmount === 1)
      .map((t) => ({ nftMint: new PublicKey(t.account.data.parsed.info.mint), nftAccount: t.pubkey }));
  }

  const out: MeteoraPosition[] = [];
  for (const { nftMint, nftAccount } of holdings) {
    const [position] = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), nftMint.toBuffer()],
      DAMM_V2_PROGRAM_ID,
    );
    const posInfo = await getInfo(connection, position);
    if (!posInfo || !posInfo.owner.equals(DAMM_V2_PROGRAM_ID)) continue;
    const pos = posInfo.data as Buffer;
    if (pos.subarray(0, 8).toString("hex") !== POSITION_DISC) continue;
    if (!pk(pos, POS_NFT_MINT).equals(nftMint)) {
      throw new Error("Meteora position layout mismatch (nft_mint) — refusing to build a withdrawal.");
    }

    const pool = pk(pos, POS_POOL);
    const poolInfo = await getInfo(connection, pool);
    if (!poolInfo) continue;
    const pd = poolInfo.data as Buffer;
    if (pd.subarray(0, 8).toString("hex") !== POOL_DISC) {
      throw new Error("Meteora pool layout mismatch (discriminator) — refusing to build a withdrawal.");
    }
    const tokenAMint = pk(pd, POOL_TOKEN_A_MINT);
    const tokenBMint = pk(pd, POOL_TOKEN_B_MINT);
    const isDaoToken = (m: PublicKey) => m.equals(dao.baseMint) || m.equals(dao.quoteMint);
    if (!isDaoToken(tokenAMint) && !isDaoToken(tokenBMint)) {
      // Not the launch pool of this DAO, or the layout moved under us. Either way, skip.
      continue;
    }

    const tokenAVault = pk(pd, POOL_TOKEN_A_VAULT);
    const tokenBVault = pk(pd, POOL_TOKEN_B_VAULT);
    const poolLiquidity = u128(pd, POOL_LIQUIDITY);
    const mine = u128(pos, POS_UNLOCKED_LIQUIDITY);
    const share = poolLiquidity.isZero() ? 0 : mine.mul(new BN(1_000_000)).div(poolLiquidity).toNumber() / 1_000_000;

    // Everything below is plain getAccountInfo decoded locally. Token programs come from
    // the mint owners (layout-independent); balances and decimals from the raw SPL
    // layouts — no getTokenAccountBalance / getMint, which some public RPCs gate.
    const [mintA, mintB, vaultA, vaultB] = await Promise.all([
      getInfo(connection, tokenAMint),
      getInfo(connection, tokenBMint),
      getInfo(connection, tokenAVault),
      getInfo(connection, tokenBVault),
    ]);
    if (!mintA || !mintB || !vaultA || !vaultB) continue;
    const tokenAProgram = mintA.owner;
    const tokenBProgram = mintB.owner;
    const decA = MintLayout.decode((mintA.data as Buffer).subarray(0, MintLayout.span)).decimals;
    const decB = MintLayout.decode((mintB.data as Buffer).subarray(0, MintLayout.span)).decimals;
    const reserveA = Number(AccountLayout.decode((vaultA.data as Buffer).subarray(0, AccountLayout.span)).amount) / 10 ** decA;
    const reserveB = Number(AccountLayout.decode((vaultB.data as Buffer).subarray(0, AccountLayout.span)).amount) / 10 ** decB;

    const label = (m: PublicKey) =>
      m.equals(dao.baseMint) ? "base" : m.equals(dao.quoteMint) ? "quote" : m.toBase58().slice(0, 6) + "…";

    out.push({
      position,
      pool,
      nftMint,
      nftAccount,
      tokenAMint,
      tokenBMint,
      tokenAVault,
      tokenBVault,
      tokenAProgram,
      tokenBProgram,
      tokenADecimals: decA,
      tokenBDecimals: decB,
      share,
      expectedA: reserveA * share,
      expectedB: reserveB * share,
      labelA: label(tokenAMint),
      labelB: label(tokenBMint),
    });
  }
  return out;
}

/**
 * Withdraw the whole position into the treasury, then forward `amountA` / `amountB`
 * (ui units) to `destination`. Thresholds are 0 for the same reason the futarchy
 * withdrawal uses min 0: reserves move during the vote and a tight bound would make
 * execution fail. The forwarded amounts, however, are exact — size them below what the
 * withdrawal is expected to return, or the transfer fails and the whole proposal with it.
 */
export function withdrawMeteoraPosition(
  dao: DaoView,
  p: MeteoraPosition,
  destination: PublicKey,
  amountA: number,
  amountB: number,
): TransactionInstruction[] {
  const treasury = dao.treasury;
  const [eventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    DAMM_V2_PROGRAM_ID,
  );
  const treasuryA = getAssociatedTokenAddressSync(p.tokenAMint, treasury, true, p.tokenAProgram);
  const treasuryB = getAssociatedTokenAddressSync(p.tokenBMint, treasury, true, p.tokenBProgram);

  const k = (pubkey: PublicKey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });
  const removeAll = new TransactionInstruction({
    programId: DAMM_V2_PROGRAM_ID,
    // args: token_a_amount_threshold u64 = 0, token_b_amount_threshold u64 = 0
    data: Buffer.concat([REMOVE_ALL_LIQUIDITY_DISC, Buffer.alloc(16)]),
    keys: [
      k(POOL_AUTHORITY),
      k(p.pool, true),
      k(p.position, true),
      k(treasuryA, true),
      k(treasuryB, true),
      k(p.tokenAVault, true),
      k(p.tokenBVault, true),
      k(p.tokenAMint),
      k(p.tokenBMint),
      k(p.nftAccount),
      k(treasury, false, true),
      k(p.tokenAProgram),
      k(p.tokenBProgram),
      k(eventAuthority),
      k(DAMM_V2_PROGRAM_ID),
    ],
  });

  const ixs: TransactionInstruction[] = [removeAll];
  const forward = (mint: PublicKey, program: PublicKey, decimals: number, from: PublicKey, amount: number) => {
    if (amount <= 0) return;
    const to = getAssociatedTokenAddressSync(mint, destination, false, program);
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(treasury, to, destination, mint, program),
      createTransferCheckedInstruction(
        from,
        mint,
        to,
        treasury,
        BigInt(Math.round(amount * 10 ** decimals)),
        decimals,
        [],
        program,
      ),
    );
  };
  forward(p.tokenAMint, p.tokenAProgram, p.tokenADecimals, treasuryA, amountA);
  forward(p.tokenBMint, p.tokenBProgram, p.tokenBDecimals, treasuryB, amountB);
  return ixs;
}

export function describeMeteoraIx(ix: TransactionInstruction): string | null {
  if (!ix.programId.equals(DAMM_V2_PROGRAM_ID)) return null;
  if (ix.data.subarray(0, 8).equals(REMOVE_ALL_LIQUIDITY_DISC)) {
    return `Meteora DAMM v2 · remove all liquidity from position ${ix.keys[2]?.pubkey.toBase58().slice(0, 8)}…`;
  }
  return "Meteora DAMM v2 · unknown instruction";
}

/**
 * Hand the position itself to `destination` instead of unwinding it: one Token-2022
 * transfer of the position NFT. Whoever holds the NFT owns the position, so the
 * recipient — a real keypair — can then call `remove_all_liquidity` top-level, claim
 * fees, or keep earning. Two instructions, ~730 bytes at creation, which leaves room for
 * an `update_dao` and a memo in the same proposal.
 *
 * Verified transferable on LFOWN's NFT (no NonTransferable / PermanentDelegate /
 * TransferHook extension, account not frozen). The mint's freeze authority is the pool
 * itself, so a position Meteora has frozen (locked/vesting) would fail here — check
 * `permanent_locked_liquidity` / `vested_liquidity` are 0 first.
 */
export function transferMeteoraPosition(
  dao: DaoView,
  p: MeteoraPosition,
  destination: PublicKey,
  /** Leave the ATA creation out — the caller has checked the account exists (see lib/ata.ts). */
  opts: { skipCreate?: boolean } = {},
): TransactionInstruction[] {
  const to = getAssociatedTokenAddressSync(p.nftMint, destination, true, TOKEN_2022_PROGRAM_ID);
  const transfer = createTransferCheckedInstruction(p.nftAccount, p.nftMint, to, dao.treasury, 1n, 0, [], TOKEN_2022_PROGRAM_ID);
  if (opts.skipCreate) return [transfer];
  return [
    createAssociatedTokenAccountIdempotentInstruction(dao.treasury, to, destination, p.nftMint, TOKEN_2022_PROGRAM_ID),
    transfer,
  ];
}

