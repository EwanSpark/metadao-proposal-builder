/**
 * A treasury swap through one Raydium CLMM pool, executed by the vault when the
 * proposal passes.
 *
 * Why not Jupiter: a route is only valid for the accounts of the moment it was quoted,
 * and a proposal executes a day or more later. A single CLMM pool is stable: the only
 * accounts that depend on the price are the tick arrays, and the program skips leading
 * tick arrays until it reaches the one holding the current price
 * (raydium-clmm swap.rs, "find the first active tick array account"). So the proposal
 * carries every initialized array from one span below the price to three above it —
 * in the swap's direction — and still executes if the price has drifted in between.
 *
 * The minimum output is fixed at creation and enforced on-chain at execution: if the
 * pool has moved against the treasury by more than the slippage allowance, the swap
 * fails and nothing leaves the vault.
 *
 * Layouts verified against the live pool EYJkpMH4… (USDv/USDC) and the program source.
 */
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { Connection } from "@solana/web3.js";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";

export const RAYDIUM_CLMM = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
/** sha256("global:swap_v2")[0..8] */
const SWAP_V2_DISC = Buffer.from("2b04ed0b1ac91e62", "hex");
const TICK_ARRAY_SIZE = 60;
const TICK_ARRAY_LEN = 10240;

const KNOWN_MINTS: Record<string, string> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  USDvUSpnhCr9yBgj3UyVrD239HRUv4RsHwH2FxsWuMk: "USDv",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
  So11111111111111111111111111111111111111112: "wSOL",
};

export type ClmmPool = {
  address: PublicKey;
  ammConfig: PublicKey;
  mint0: PublicKey;
  mint1: PublicKey;
  vault0: PublicKey;
  vault1: PublicKey;
  observation: PublicKey;
  decimals0: number;
  decimals1: number;
  tickSpacing: number;
  liquidity: BN;
  sqrtPriceX64: BN;
  tickCurrent: number;
  program0: PublicKey;
  program1: PublicKey;
  /** Trade fee of the pool's config, in millionths. */
  tradeFeeRate: number;
};

export async function readClmmPool(connection: Connection, address: PublicKey): Promise<ClmmPool> {
  const info = await connection.getAccountInfo(address);
  if (!info) throw new Error("Pool account not found.");
  if (!info.owner.equals(RAYDIUM_CLMM)) throw new Error("This account is not a Raydium CLMM pool.");
  const b = info.data as Buffer;
  const pk = (o: number) => new PublicKey(b.subarray(o, o + 32));
  const u128 = (o: number) => new BN(b.subarray(o, o + 16), "le");
  const pool = {
    address,
    ammConfig: pk(9),
    mint0: pk(73),
    mint1: pk(105),
    vault0: pk(137),
    vault1: pk(169),
    observation: pk(201),
    decimals0: b[233],
    decimals1: b[234],
    tickSpacing: b.readUInt16LE(235),
    liquidity: u128(237),
    sqrtPriceX64: u128(253),
    tickCurrent: b.readInt32LE(269),
  };
  const [m0, m1, cfg] = await connection.getMultipleAccountsInfo([pool.mint0, pool.mint1, pool.ammConfig]);
  if (!m0 || !m1 || !cfg) throw new Error("Pool mints or config not found.");
  // AmmConfig: disc 8, bump 1, index u16, owner 32, protocol_fee_rate u32, trade_fee_rate u32
  const tradeFeeRate = (cfg.data as Buffer).readUInt32LE(8 + 1 + 2 + 32 + 4);
  return { ...pool, program0: m0.owner, program1: m1.owner, tradeFeeRate };
}

/** Price of token0 in token1, human units. */
export function clmmPrice(pool: ClmmPool): number {
  const s = Number(pool.sqrtPriceX64.toString()) / 2 ** 64;
  return s * s * 10 ** (pool.decimals0 - pool.decimals1);
}

const arrayStart = (tick: number, spacing: number) => {
  const span = spacing * TICK_ARRAY_SIZE;
  return Math.floor(tick / span) * span;
};

function tickArrayPda(pool: PublicKey, start: number): PublicKey {
  const be = Buffer.alloc(4);
  be.writeInt32BE(start);
  return PublicKey.findProgramAddressSync([Buffer.from("tick_array"), pool.toBuffer(), be], RAYDIUM_CLMM)[0];
}

/**
 * Every initialized tick array from one span behind the current price to three spans
 * ahead of it, ordered in the swap's direction, plus the bitmap extension if the pool
 * has one.
 */
async function swapRemainingAccounts(connection: Connection, pool: ClmmPool, zeroForOne: boolean): Promise<PublicKey[]> {
  const span = pool.tickSpacing * TICK_ARRAY_SIZE;
  const here = arrayStart(pool.tickCurrent, pool.tickSpacing);
  // zeroForOne lowers the price: walk downward. oneForZero raises it: walk upward.
  const step = zeroForOne ? -span : span;
  const starts = [-1, 0, 1, 2, 3].map((k) => here + k * step);
  const arrays = starts.map((s) => tickArrayPda(pool.address, s));
  const ext = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_tick_array_bitmap_extension"), pool.address.toBuffer()],
    RAYDIUM_CLMM,
  )[0];
  const infos = await connection.getMultipleAccountsInfo([ext, ...arrays]);
  const out: PublicKey[] = [];
  if (infos[0]) out.push(ext);
  arrays.forEach((a, i) => {
    if (infos[i + 1]?.data.length === TICK_ARRAY_LEN) out.push(a);
  });
  if (out.filter((k) => !k.equals(ext)).length === 0) {
    throw new Error("No initialized tick array around the current price — this pool has no liquidity there.");
  }
  return out;
}

/** Constant-liquidity estimate of the output, fee included. Good within one tick array. */
export function estimateClmmOut(pool: ClmmPool, inputMint: PublicKey, amountIn: BN): BN {
  const zeroForOne = inputMint.equals(pool.mint0);
  const afterFee = Number(amountIn.toString()) * (1 - pool.tradeFeeRate / 1e6);
  const s = Number(pool.sqrtPriceX64.toString()) / 2 ** 64; // raw units
  const L = Number(pool.liquidity.toString());
  if (L === 0) return new BN(0);
  let out: number;
  if (zeroForOne) {
    const s2 = (L * s) / (L + afterFee * s);
    out = L * (s - s2);
  } else {
    const s2 = s + afterFee / L;
    out = L * (1 / s - 1 / s2);
  }
  return new BN(Math.max(0, Math.floor(out)).toString());
}

export type ClmmSwap = {
  pool: ClmmPool;
  owner: PublicKey;
  inputMint: PublicKey;
  amountIn: BN;
  minOut: BN;
};

/** `swap_v2`, exact input, signed by `owner` (the treasury vault). */
export async function clmmSwapIx(connection: Connection, s: ClmmSwap): Promise<TransactionInstruction> {
  const { pool, owner, inputMint } = s;
  const zeroForOne = inputMint.equals(pool.mint0);
  if (!zeroForOne && !inputMint.equals(pool.mint1)) throw new Error("The input token is not in this pool.");
  const [inMint, outMint] = zeroForOne ? [pool.mint0, pool.mint1] : [pool.mint1, pool.mint0];
  const [inProg, outProg] = zeroForOne ? [pool.program0, pool.program1] : [pool.program1, pool.program0];
  const [inVault, outVault] = zeroForOne ? [pool.vault0, pool.vault1] : [pool.vault1, pool.vault0];
  const remaining = await swapRemainingAccounts(connection, pool, zeroForOne);

  const data = Buffer.alloc(8 + 8 + 8 + 16 + 1);
  SWAP_V2_DISC.copy(data, 0);
  data.writeBigUInt64LE(BigInt(s.amountIn.toString()), 8);
  data.writeBigUInt64LE(BigInt(s.minOut.toString()), 16);
  // sqrt_price_limit_x64 = 0 → no limit; the minimum output is the guard.
  data[40] = 1; // is_base_input: amount is the exact input

  const w = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });
  const r = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
  return new TransactionInstruction({
    programId: RAYDIUM_CLMM,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: false },
      r(pool.ammConfig),
      w(pool.address),
      w(getAssociatedTokenAddressSync(inMint, owner, true, inProg)),
      w(getAssociatedTokenAddressSync(outMint, owner, true, outProg)),
      w(inVault),
      w(outVault),
      w(pool.observation),
      r(TOKEN_PROGRAM_ID),
      r(TOKEN_2022_PROGRAM_ID),
      r(MEMO_PROGRAM),
      r(inMint),
      r(outMint),
      ...remaining.map(w),
    ],
    data,
  });
}

/**
 * The deepest direct Raydium CLMM pool between two mints, and Jupiter's output for this
 * exact amount through it (Jupiter walks the real ticks, so it beats the local estimate
 * when the swap crosses them).
 */
export async function findClmmPool(
  inputMint: PublicKey,
  outputMint: PublicKey,
  amountIn: BN,
): Promise<{ pool: PublicKey; quotedOut: BN }> {
  const url =
    `https://lite-api.jup.ag/swap/v1/quote?inputMint=${inputMint.toBase58()}&outputMint=${outputMint.toBase58()}` +
    `&amount=${amountIn.toString()}&onlyDirectRoutes=true&dexes=${encodeURIComponent("Raydium CLMM")}`;
  const res = await fetch(url);
  const q: any = await res.json().catch(() => ({}));
  const legs: any[] = q?.routePlan ?? [];
  if (!res.ok || legs.length === 0) {
    throw new Error(`No direct Raydium CLMM pool between these tokens${q?.error ? ` (${q.error})` : ""}. Paste a pool address.`);
  }
  if (legs.length > 1) {
    throw new Error("Jupiter splits this amount across several pools. Paste one pool address, or swap less.");
  }
  return { pool: new PublicKey(legs[0].swapInfo.ammKey), quotedOut: new BN(q.outAmount) };
}

export function describeClmmIx(ix: TransactionInstruction): string | null {
  if (!ix.programId.equals(RAYDIUM_CLMM)) return null;
  if (!ix.data.subarray(0, 8).equals(SWAP_V2_DISC)) return "Raydium CLMM · instruction";
  const amount = ix.data.readBigUInt64LE(8);
  const min = ix.data.readBigUInt64LE(16);
  const name = (k: PublicKey | undefined) => {
    const s = k?.toBase58() ?? "?";
    return KNOWN_MINTS[s] ?? `${s.slice(0, 4)}…`;
  };
  return `Raydium swap ${amount} raw ${name(ix.keys[11]?.pubkey)} → min ${min} raw ${name(ix.keys[12]?.pubkey)}`;
}
