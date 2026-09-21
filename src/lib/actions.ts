import { FutarchyClient } from "@metadaoproject/programs/futarchy";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import BN from "bn.js";
import type { DaoView } from "./futarchy";
import { COFFRE_PROGRAM_ID, IDL as COFFRE_IDL } from "./coffre";
import { describeSpendingLimitIx } from "./spendingLimit";
import { describeMeteoraIx } from "./meteora";
import { describeTokenMetadataIx } from "./tokenMetadata";

/**
 * Every instruction below is executed later BY THE TREASURY (the Squads vault PDA),
 * not by the proposer. So the vault is always the authority / signer.
 */

export function spendFromTreasury(
  dao: DaoView,
  recipient: PublicKey,
  rawAmount: BN,
  createRecipientAta: boolean,
): TransactionInstruction[] {
  const from = getAssociatedTokenAddressSync(dao.quoteMint, dao.treasury, true);
  const to = getAssociatedTokenAddressSync(dao.quoteMint, recipient, true);

  const ixs: TransactionInstruction[] = [];
  if (createRecipientAta) {
    // Rent is paid by the vault, so it needs a little SOL.
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(dao.treasury, to, recipient, dao.quoteMint),
    );
  }
  ixs.push(
    createTransferCheckedInstruction(
      from,
      dao.quoteMint,
      to,
      dao.treasury,
      BigInt(rawAmount.toString()),
      dao.quoteDecimals,
    ),
  );
  return ixs;
}

export async function increaseLiquidity(
  client: FutarchyClient,
  dao: DaoView,
  quoteAmount: BN,
  maxBaseAmount: BN,
): Promise<TransactionInstruction[]> {
  const ix = await client
    .provideLiquidityIx({
      dao: dao.address,
      baseMint: dao.baseMint,
      quoteMint: dao.quoteMint,
      quoteAmount,
      maxBaseAmount,
      minLiquidity: new BN(1),
      positionAuthority: dao.treasury,
      liquidityProvider: dao.treasury,
    })
    .instruction();
  return [ix];
}

/**
 * `withdrawLiquidityIx` is missing from the published SDK (0.1.1-alpha.0),
 * so this builds it from the on-chain program directly.
 */
export async function decreaseLiquidity(
  client: FutarchyClient,
  dao: DaoView,
  liquidityToWithdraw: BN,
  minBaseAmount: BN,
  minQuoteAmount: BN,
): Promise<TransactionInstruction[]> {
  const [ammPosition] = PublicKey.findProgramAddressSync(
    [Buffer.from("amm_position"), dao.address.toBuffer(), dao.treasury.toBuffer()],
    client.getProgramId(),
  );

  const ix = await (client.futarchy as any).methods
    .withdrawLiquidity({ liquidityToWithdraw, minBaseAmount, minQuoteAmount })
    .accounts({
      dao: dao.address,
      positionAuthority: dao.treasury,
      liquidityProviderBaseAccount: getAssociatedTokenAddressSync(dao.baseMint, dao.treasury, true),
      liquidityProviderQuoteAccount: getAssociatedTokenAddressSync(dao.quoteMint, dao.treasury, true),
      ammBaseVault: getAssociatedTokenAddressSync(dao.baseMint, dao.address, true),
      ammQuoteVault: getAssociatedTokenAddressSync(dao.quoteMint, dao.address, true),
      ammPosition,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();

  return [ix];
}

/** Full liquidity withdrawal needs the position's current liquidity. */
export async function readPositionLiquidity(
  client: FutarchyClient,
  dao: DaoView,
): Promise<BN | null> {
  const [ammPosition] = PublicKey.findProgramAddressSync(
    [Buffer.from("amm_position"), dao.address.toBuffer(), dao.treasury.toBuffer()],
    client.getProgramId(),
  );
  const acc = await (client.futarchy.account as any).ammPosition.fetchNullable(ammPosition);
  return acc ? (acc.liquidity as BN) : null;
}

/* ---------------------------------------------------------------- buyback */

const DCA_PROGRAM_ID = new PublicKey("DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M");
const DCA_EVENT_AUTHORITY = new PublicKey("Cspp27eGUDMXxPEdhmEXFVRn6Lt1L7xJyALF3nmnWoBj");
/** sha256("global:open_dca_v2")[0..8] — verified against Ranger #2. */
const OPEN_DCA_V2_DISCRIMINATOR = Buffer.from("8e772b6da2340bb1", "hex");

export type BuybackParams = {
  /** Total quote to spend, raw units. */
  totalIn: BN;
  /** Number of orders (Ranger used 8640). */
  orders: number;
  /** Seconds between orders (Ranger used 300). */
  intervalSeconds: number;
  /** Max price in quote per base, UI units. null = no cap. */
  maxPrice: number | null;
  /** Must be unique per (user, mints). Defaults to now. */
  applicationIdx?: number;
};

export type BuybackPlan = {
  perCycle: BN;
  minOutPerCycle: BN | null;
  dca: PublicKey;
  applicationIdx: number;
  estimatedBase: BN | null;
  durationSeconds: number;
  /** ceil(inAmount / perCycle) — the count the program actually derives. */
  effectiveOrders: number;
  /** Remainder swept by a final partial cycle, raw quote units. */
  dust: BN;
};

/**
 * Guardrails come from Jupiter's on-chain IDL (program DCA265Vj…, v0.1.0):
 *   6000 InvalidAmount · 6001 InvalidCycleAmount · 6002 InvalidPair
 *   6003 TooFrequent · 6004 InvalidMinPrice · 6006 InAmountInsufficient
 *   6014 UserInsufficientBalance
 * We pre-check what we can so a bad proposal fails here, not three days later
 * at execution.
 */
export function planBuyback(dao: DaoView, p: BuybackParams): BuybackPlan {
  if (!Number.isFinite(p.orders) || p.orders < 2)
    throw new Error("At least 2 orders — Jupiter requires inAmount > inAmountPerCycle (6006).");
  if (!Number.isFinite(p.intervalSeconds) || p.intervalSeconds <= 0)
    throw new Error("Invalid interval — the program rejects cycles that are too frequent (6003).");
  if (p.totalIn.isZero()) throw new Error("Total amount is zero (6013).");
  if (dao.baseMint.equals(dao.quoteMint)) throw new Error("Invalid pair (6002).");

  const perCycle = p.totalIn.divn(p.orders);
  if (perCycle.isZero()) throw new Error("Per-order amount is zero — reduce the number of orders.");
  if (perCycle.gte(p.totalIn))
    throw new Error("Per-order amount must be strictly below the total (6006).");

  // minOutAmount is how Jupiter expresses a max price: perCycle / maxPrice,
  // rescaled between quote and base decimals. Reproduces Ranger's 296771129 exactly.
  let minOutPerCycle: BN | null = null;
  if (p.maxPrice !== null) {
    if (p.maxPrice <= 0) throw new Error("Invalid max price.");
    const scale = 10 ** (dao.baseDecimals - dao.quoteDecimals);
    const value = Math.floor((Number(perCycle.toString()) * scale) / p.maxPrice);
    if (!Number.isFinite(value) || value <= 0)
      throw new Error("Max price out of range — minOutAmount must be > 0 (6004).");
    minOutPerCycle = new BN(value.toString());
  }

  // The instruction carries (inAmount, inAmountPerCycle); the cycle count is derived
  // on-chain, so a non-divisible total leaves a final partial cycle.
  const dust = p.totalIn.sub(perCycle.muln(p.orders));
  const effectiveOrders = dust.isZero() ? p.orders : p.orders + 1;

  const applicationIdx = p.applicationIdx ?? Math.floor(Date.now() / 1000);
  const idx = Buffer.alloc(8);
  idx.writeBigUInt64LE(BigInt(applicationIdx));
  const [dca] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("dca"),
      dao.treasury.toBuffer(),
      dao.quoteMint.toBuffer(),
      dao.baseMint.toBuffer(),
      idx,
    ],
    DCA_PROGRAM_ID,
  );

  return {
    perCycle,
    minOutPerCycle,
    dca,
    applicationIdx,
    estimatedBase: minOutPerCycle ? minOutPerCycle.muln(p.orders) : null,
    durationSeconds: effectiveOrders * p.intervalSeconds,
    effectiveOrders,
    dust,
  };
}

/**
 * Treasury buyback via a Jupiter DCA recurring order — the shape Ranger #2 used
 * and executed on mainnet (2M USDC → RNGR, 8640 orders of 231.481481 every 300s,
 * max price $0.78). Instruction list, account flags, arg layout and every PDA here
 * were reverse-engineered from that transaction and reproduce it byte for byte.
 */
export function jupiterDcaBuyback(
  dao: DaoView,
  p: BuybackParams,
  plan: BuybackPlan,
): TransactionInstruction[] {
  const userAta = getAssociatedTokenAddressSync(dao.quoteMint, dao.treasury, true);
  const inAta = getAssociatedTokenAddressSync(dao.quoteMint, plan.dca, true);
  const outAta = getAssociatedTokenAddressSync(dao.baseMint, plan.dca, true);

  const parts: Buffer[] = [OPEN_DCA_V2_DISCRIMINATOR];
  const u64 = (v: BN | number | bigint) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(v.toString()));
    return b;
  };
  parts.push(u64(plan.applicationIdx));
  parts.push(u64(p.totalIn));
  parts.push(u64(plan.perCycle));
  parts.push(u64(p.intervalSeconds));
  if (plan.minOutPerCycle) parts.push(Buffer.from([1]), u64(plan.minOutPerCycle));
  else parts.push(Buffer.from([0]));
  parts.push(Buffer.from([0])); // maxOutAmount: None
  parts.push(Buffer.from([0])); // startAt: None

  const rw = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });
  const ro = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });

  const openDca = new TransactionInstruction({
    programId: DCA_PROGRAM_ID,
    keys: [
      rw(plan.dca),
      { pubkey: dao.treasury, isSigner: true, isWritable: true }, // user
      { pubkey: dao.treasury, isSigner: true, isWritable: true }, // payer
      ro(dao.quoteMint),
      ro(dao.baseMint),
      rw(userAta),
      rw(inAta),
      rw(outAta),
      ro(SystemProgram.programId),
      ro(TOKEN_PROGRAM_ID),
      ro(ASSOCIATED_TOKEN_PROGRAM_ID),
      ro(DCA_EVENT_AUTHORITY),
      ro(DCA_PROGRAM_ID),
    ],
    data: Buffer.concat(parts),
  });

  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 130_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }),
    createAssociatedTokenAccountIdempotentInstruction(
      dao.treasury,
      userAta,
      dao.treasury,
      dao.quoteMint,
    ),
    openDca,
  ];
}

/** SPL Memo v2. */
/* ------------------------------------------------------- DAO parameters */

export type DaoParamChanges = {
  /** New vote length, seconds. Omit to leave it alone. */
  secondsPerProposal?: number;
  /** New TWAP start delay, seconds. Omit to leave it alone. */
  twapStartDelaySeconds?: number;
};

/**
 * Shortest vote the program accepts, given a TWAP start delay.
 *
 * Error 6011 reads "Proposal duration must be longer 1 day and longer than 2 times
 * the TWAP start delay" — both bounds strict. The chain proves the second one is
 * strict: three DAOs sit at exactly 172801s with a 86400s delay, one second above
 * 2 × 86400, which is where you land when you push a round number down until the
 * program stops accepting it.
 */
export function minimumProposalSeconds(twapStartDelaySeconds: number): number {
  return Math.max(86400, 2 * twapStartDelaySeconds) + 1;
}

/**
 * Whether a duration/delay pair would be accepted, and why not if it wouldn't.
 * Checked here so the failure shows up while composing rather than three days
 * later when the vote executes.
 */
export function checkDaoParams(dao: DaoView, c: DaoParamChanges): string | null {
  const delay = c.twapStartDelaySeconds ?? dao.twapStartDelaySeconds;
  const duration = c.secondsPerProposal ?? dao.secondsPerProposal;
  if (c.secondsPerProposal === undefined && c.twapStartDelaySeconds === undefined) {
    return "Nothing to change.";
  }
  if (duration <= 86400) {
    return `Duration must be strictly longer than 1 day: ${duration}s ≤ 86400s (error 6011).`;
  }
  if (duration <= 2 * delay) {
    return (
      `Duration must exceed 2 × TWAP start delay: ${duration}s ≤ ${2 * delay}s (error 6011). ` +
      `Lower the delay to at most ${Math.floor((duration - 1) / 2)}s in the same proposal.`
    );
  }
  return null;
}

/**
 * Change the DAO's own parameters. The treasury vault signs, so this only ever runs
 * as the instruction of a proposal that passed — a DAO cannot shorten its own votes
 * except by winning a vote at the current length.
 */
export async function updateDaoParams(
  client: FutarchyClient,
  dao: DaoView,
  changes: DaoParamChanges,
): Promise<TransactionInstruction[]> {
  const ix = await (client.futarchy as any).methods
    .updateDao({
      passThresholdBps: null,
      secondsPerProposal: changes.secondsPerProposal ?? null,
      twapInitialObservation: null,
      twapMaxObservationChangePerUpdate: null,
      twapStartDelaySeconds: changes.twapStartDelaySeconds ?? null,
      minQuoteFutarchicLiquidity: null,
      minBaseFutarchicLiquidity: null,
      baseToStake: null,
      teamSponsoredPassThresholdBps: null,
      teamAddress: null,
      isOptimisticGovernanceEnabled: null,
    })
    .accounts({ dao: dao.address, squadsMultisigVault: dao.treasury })
    .instruction();

  return [ix];
}

export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

/**
 * A liquidation proposal carries no transfers. Both real ones on mainnet are a
 * single memo with zero accounts — the market votes a mandate, and MetaDAO then
 * runs the `liquidation` program (LiQnow…) with its own record/liquidation
 * authorities. Verified on-chain:
 *   Ranger  #4 passed — "Approve the liquidation of Ranger and transfer the IP to Glint House Pte. Ltd."
 *   Superclaw #3 failed — "We hereby authorize the liquidation of the treasury and return of IP to the original owners"
 */
export function authorizationMemo(message: string): TransactionInstruction[] {
  const text = message.trim();
  if (!text) throw new Error("Memo cannot be empty.");
  return [
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [],
      data: Buffer.from(text, "utf8"),
    }),
  ];
}

export const LIQUIDATION_TEMPLATES: { label: string; text: string }[] = [
  {
    label: "Ranger (passed)",
    text: "Approve the liquidation of <PROJET> and transfer the IP to <ENTITÉ LÉGALE>.",
  },
  {
    label: "Superclaw (rejected)",
    text: "We hereby authorize the liquidation of the treasury and return of IP to the original owners",
  },
];

export type RawIxJson = {
  programId: string;
  keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string; // base64
};

/**
 * Escape hatch — covers anything the forms don't: token metadata updates,
 * Meteora DAMM withdrawals, liquidation setup, mint governor calls.
 */
export function parseRawInstructions(json: string): TransactionInstruction[] {
  const parsed = JSON.parse(json);
  const list: RawIxJson[] = Array.isArray(parsed) ? parsed : [parsed];
  return list.map((raw) => {
    if (!raw.programId || !Array.isArray(raw.keys) || typeof raw.data !== "string") {
      throw new Error("Each instruction needs { programId, keys[], data (base64) }");
    }
    return new TransactionInstruction({
      programId: new PublicKey(raw.programId),
      keys: raw.keys.map((k) => ({
        pubkey: new PublicKey(k.pubkey),
        isSigner: !!k.isSigner,
        isWritable: !!k.isWritable,
      })),
      data: Buffer.from(raw.data, "base64"),
    });
  });
}

/** Names for the programs a proposal realistically calls — used to label instructions. */
const PROGRAM_NAMES: Record<string, string> = {
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: "SPL Memo",
  cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG: "Meteora DAMM v2",
  DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M: "Jupiter DCA",
  FUTARELBfJfQ8RDGhg1wdhddq1odMAJUePHFuBYfUxKq: "MetaDAO futarchy",
  LiQnowFbFQdYyZhF4pUbpsrZCjxRTQ1upKJxZ2VXjde: "MetaDAO liquidation",
  omnixgS8fnqHfCcTGKWj6JtKjzpJZ1Y5y9pyFkQDkYE: "Omnipair",
  SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf: "Squads v4",
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "SPL Token",
  "11111111111111111111111111111111": "System",
  metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s: "Metaplex metadata",
  CcmRKTuZCGJBWQwMHvDYApBRvSZNHqGJXkznqpDTSQUr: "Collector Crypt",
  [COFFRE_PROGRAM_ID.toBase58()]: "Coffre",
};

const COFFRE_IX_NAMES: Record<string, string> = Object.fromEntries(
  (COFFRE_IDL as any).instructions.map((ix: any) => [Buffer.from(ix.discriminator).toString("hex"), ix.name]),
);

export function programLabel(id: string): string {
  return PROGRAM_NAMES[id] ?? `${id.slice(0, 8)}…`;
}

/** sha256("global:update_dao")[0..8] — so a queued parameter change reads as one. */
const UPDATE_DAO_DISC = "83484b1970d26d02";

export function describeInstruction(ix: TransactionInstruction): string {
  if (ix.programId.equals(MEMO_PROGRAM_ID)) {
    return `Memo · ${JSON.stringify(ix.data.toString("utf8"))}`;
  }
  if (ix.data.subarray(0, 8).toString("hex") === UPDATE_DAO_DISC) {
    return "Update DAO parameters";
  }
  if (ix.programId.equals(COFFRE_PROGRAM_ID)) {
    const name = COFFRE_IX_NAMES[ix.data.subarray(0, 8).toString("hex")];
    return name ? `Coffre · ${name}` : "Coffre · unknown instruction";
  }
  const met = describeMeteoraIx(ix);
  if (met) return met;
  const tm = describeTokenMetadataIx(ix);
  if (tm) return tm;
  const limit = describeSpendingLimitIx(ix);
  if (limit) return limit;
  const signers = ix.keys.filter((k) => k.isSigner).length;
  return `${ix.programId.toBase58().slice(0, 8)}… · ${ix.keys.length} accounts (${signers} signer) · ${ix.data.length}o`;
}
