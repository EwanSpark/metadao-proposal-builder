/**
 * Destination token accounts for instructions the treasury will execute later.
 *
 * A proposal that creates the recipient's ATA makes the TREASURY pay its rent
 * (~0.002 SOL each) at execution. Launchpad treasuries usually hold a few thousandths of
 * a SOL, but not always — the Spark test DAO's vault holds exactly 0 — and a missing
 * lamport fails the whole vault transaction after a multi-day vote. So: skip the create
 * when the account already exists (it also saves ~60–150 bytes of a 1232-byte budget),
 * and when it does not, either confirm the vault can afford it or create it up front
 * from the proposer's wallet, which anyone may do for any owner.
 */
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import type { Connection } from "@solana/web3.js";
import { PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";

export type AtaNeed = { mint: PublicKey; owner: PublicKey; program?: PublicKey };
export type AtaStatus = AtaNeed & { ata: PublicKey; exists: boolean };

/** Rent-exempt minimum of a plain token account; Token-2022 NFTs accounts are a touch larger. */
const ATA_RENT_LAMPORTS = 2_100_000;

export async function checkAtas(connection: Connection, needs: AtaNeed[]): Promise<AtaStatus[]> {
  const out: AtaStatus[] = [];
  for (const n of needs) {
    const program = n.program ?? TOKEN_PROGRAM_ID;
    const ata = getAssociatedTokenAddressSync(n.mint, n.owner, true, program, ASSOCIATED_TOKEN_PROGRAM_ID);
    const info = await connection.getAccountInfo(ata);
    out.push({ ...n, program, ata, exists: !!info });
  }
  return out;
}

/**
 * Decide, per destination, whether the proposal must carry a create instruction.
 * Throws — rather than queueing something doomed — when accounts are missing and the
 * treasury cannot pay for them.
 */
export async function planAtaCreates(
  connection: Connection,
  treasury: PublicKey,
  needs: AtaNeed[],
): Promise<{ statuses: AtaStatus[]; createByTreasury: TransactionInstruction[] }> {
  const statuses = await checkAtas(connection, needs);
  const missing = statuses.filter((s) => !s.exists);
  if (missing.length === 0) return { statuses, createByTreasury: [] };
  const lamports = await connection.getBalance(treasury);
  const required = missing.length * ATA_RENT_LAMPORTS;
  if (lamports < required) {
    throw new Error(
      `${missing.length} destination token account(s) do not exist and the treasury holds ` +
        `${(lamports / 1e9).toFixed(4)} SOL — not the ~${(required / 1e9).toFixed(4)} SOL their rent needs, so execution would fail. ` +
        `Use "Create destination accounts from my wallet" first, then add again.`,
    );
  }
  return {
    statuses,
    createByTreasury: missing.map((s) =>
      createAssociatedTokenAccountIdempotentInstruction(treasury, s.ata, s.owner, s.mint, s.program),
    ),
  };
}

/** One wallet-paid transaction creating every missing destination account. */
export function createAtasTx(payer: PublicKey, missing: AtaStatus[]): Transaction {
  const tx = new Transaction();
  for (const s of missing) {
    tx.add(createAssociatedTokenAccountIdempotentInstruction(payer, s.ata, s.owner, s.mint, s.program));
  }
  tx.feePayer = payer;
  return tx;
}
