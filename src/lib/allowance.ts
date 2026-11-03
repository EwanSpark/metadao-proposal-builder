/**
 * The DAO's monthly allowance: a Squads spending limit on the treasury vault. A listed
 * member withdraws from it with their own signature — no proposal, no vote — up to what
 * is left in the current period.
 *
 * Reset rule, from Squads v4 `spending_limit_use`: when more than one period has passed
 * since `last_reset`, the remaining amount goes back to the full amount and `last_reset`
 * advances by whole periods. Month = 30 days, not a calendar month.
 */
import {
  MintLayout,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import type { Connection } from "@solana/web3.js";
import { PublicKey, Transaction } from "@solana/web3.js";
import * as multisig from "@sqds/multisig";
import type { DaoView } from "./futarchy";

/** base58 of sha256("account:SpendingLimit")[0..8] */
const SPENDING_LIMIT_DISC_B58 = "2odkUytTTsV";
const PERIOD_SECONDS: Record<number, number | null> = { 0: null, 1: 86_400, 2: 604_800, 3: 2_592_000 };
export const PERIOD_LABEL: Record<number, string> = { 0: "one time", 1: "day", 2: "week", 3: "30 days" };

export type Allowance = {
  address: PublicKey;
  mint: PublicKey | null; // null = SOL
  tokenProgram: PublicKey;
  decimals: number;
  symbol: string;
  amount: bigint;
  /** What a withdrawal right now can take, after applying any pending reset. */
  available: bigint;
  period: number;
  nextReset: Date | null;
  members: PublicKey[];
  destinations: PublicKey[];
  vaultIndex: number;
};

const KNOWN: Record<string, string> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
};

/**
 * Every spending limit on the DAO's multisig. Falls back to the launchpad's own limit
 * (create key = DAO address) when the RPC refuses getProgramAccounts.
 */
export async function findAllowances(connection: Connection, dao: DaoView): Promise<Allowance[]> {
  let keys: PublicKey[];
  try {
    const found = await connection.getProgramAccounts(multisig.PROGRAM_ID, {
      dataSlice: { offset: 0, length: 0 },
      filters: [
        { memcmp: { offset: 0, bytes: SPENDING_LIMIT_DISC_B58 } },
        { memcmp: { offset: 8, bytes: dao.multisig.toBase58() } },
      ],
    });
    keys = found.map((f) => f.pubkey);
  } catch {
    keys = [multisig.getSpendingLimitPda({ multisigPda: dao.multisig, createKey: dao.address })[0]];
  }
  const infos = await connection.getMultipleAccountsInfo(keys);
  const now = Math.floor(Date.now() / 1000);
  const out: Allowance[] = [];
  for (let i = 0; i < keys.length; i++) {
    const info = infos[i];
    if (!info) continue;
    const [sl] = multisig.accounts.SpendingLimit.fromAccountInfo(info);
    const isSol = sl.mint.equals(PublicKey.default);
    let decimals = 9, tokenProgram = TOKEN_PROGRAM_ID;
    if (!isSol) {
      const m = await connection.getAccountInfo(sl.mint);
      if (!m) continue;
      tokenProgram = m.owner;
      decimals = MintLayout.decode((m.data as Buffer).subarray(0, MintLayout.span)).decimals;
    }
    const period = Number(sl.period);
    const amount = BigInt(sl.amount.toString());
    let available = BigInt(sl.remainingAmount.toString());
    let lastReset = Number(sl.lastReset.toString());
    const len = PERIOD_SECONDS[period];
    if (len) {
      const passed = now - lastReset;
      if (passed > len) {
        available = amount;
        lastReset += Math.floor(passed / len) * len;
      }
    }
    out.push({
      address: keys[i],
      mint: isSol ? null : sl.mint,
      tokenProgram,
      decimals,
      symbol: isSol ? "SOL" : KNOWN[sl.mint.toBase58()] ?? `${sl.mint.toBase58().slice(0, 4)}…`,
      amount,
      available,
      period,
      // The counter resets on the first use *after* a full period has elapsed.
      nextReset: len ? new Date((lastReset + len) * 1000) : null,
      members: sl.members,
      destinations: sl.destinations,
      vaultIndex: sl.vaultIndex,
    });
  }
  return out;
}

/** One transaction: the destination's token account if missing, then the withdrawal. */
export function withdrawAllowanceTx(dao: DaoView, a: Allowance, member: PublicKey, destination: PublicKey, amountRaw: bigint): Transaction {
  if (!a.members.some((m) => m.equals(member))) throw new Error("The connected wallet is not a member of this allowance.");
  if (a.destinations.length && !a.destinations.some((d) => d.equals(destination)))
    throw new Error("This allowance only pays out to its listed destinations.");
  if (amountRaw <= 0n) throw new Error("Enter an amount.");
  if (amountRaw > a.available) throw new Error("More than what is left this period.");
  const tx = new Transaction();
  if (a.mint) {
    // The program requires the destination token account to exist; the member pays its rent.
    const ata = getAssociatedTokenAddressSync(a.mint, destination, true, a.tokenProgram);
    tx.add(createAssociatedTokenAccountIdempotentInstruction(member, ata, destination, a.mint, a.tokenProgram));
  }
  tx.add(
    multisig.instructions.spendingLimitUse({
      multisigPda: dao.multisig,
      member,
      spendingLimit: a.address,
      mint: a.mint ?? undefined,
      vaultIndex: a.vaultIndex,
      amount: Number(amountRaw),
      decimals: a.decimals,
      destination,
      tokenProgram: a.tokenProgram,
    }),
  );
  tx.feePayer = member;
  return tx;
}
