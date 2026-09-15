/**
 * Squads spending limits, and the second way a passed proposal executes.
 *
 * A DAO's multisig config (spending limits included) can only be changed by the
 * config authority — the DAO account, which only the futarchy program can make
 * sign. `execute_spending_limit_change` does exactly that, but refuses any inner
 * instruction other than `MultisigAddSpendingLimit` / `MultisigRemoveSpendingLimit`.
 * So a spending-limit proposal must contain nothing else ("Path B"), and every
 * other proposal executes through the permissionless member ("Path A").
 */
import { PERMISSIONLESS_ACCOUNT } from "@metadaoproject/programs";
import { FutarchyClient } from "@metadaoproject/programs/futarchy";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import * as multisig from "@sqds/multisig";
import type { SendFn } from "./flow";
import type { DaoView } from "./futarchy";
import { decodeSpendingLimit, type SpendingLimit } from "./coffre";

export const SQUADS_PROGRAM_ID = multisig.PROGRAM_ID;

/** sha256("global:<name>")[0..8] */
const ADD_LIMIT_DISC = Buffer.from([11, 242, 159, 42, 86, 197, 89, 115]);
const REMOVE_LIMIT_DISC = Buffer.from([228, 198, 136, 111, 123, 4, 178, 113]);
/** sha256("account:SpendingLimit")[0..8] */
const SPENDING_LIMIT_ACCOUNT_DISC = Buffer.from([10, 201, 27, 160, 218, 195, 222, 152]);

export type Period = "OneTime" | "Day" | "Week" | "Month";
const PERIODS: Record<Period, multisig.types.Period> = {
  OneTime: multisig.types.Period.OneTime,
  Day: multisig.types.Period.Day,
  Week: multisig.types.Period.Week,
  Month: multisig.types.Period.Month,
};

export function spendingLimitPda(multisigPda: PublicKey, createKey: PublicKey): PublicKey {
  return multisig.getSpendingLimitPda({ multisigPda, createKey })[0];
}

/**
 * `MultisigAddSpendingLimit`. The DAO account signs as config authority (the
 * futarchy program provides that signature on Path B); the treasury vault pays
 * the rent, because Squads signs for the vault inside every vault transaction and
 * no human signature is then needed at execution time.
 */
export function addSpendingLimit(
  dao: DaoView,
  args: {
    createKey: PublicKey;
    mint: PublicKey;
    amount: bigint;
    period: Period;
    members: PublicKey[];
    destinations: PublicKey[];
    memo?: string;
  },
): TransactionInstruction {
  return multisig.instructions.multisigAddSpendingLimit({
    multisigPda: dao.multisig,
    spendingLimit: spendingLimitPda(dao.multisig, args.createKey),
    configAuthority: dao.address,
    rentPayer: dao.treasury,
    createKey: args.createKey,
    vaultIndex: 0,
    mint: args.mint,
    amount: args.amount,
    period: PERIODS[args.period],
    members: args.members,
    destinations: args.destinations,
    memo: args.memo,
  });
}

/** `MultisigRemoveSpendingLimit`; the rent goes back to the treasury vault. */
export function removeSpendingLimit(dao: DaoView, spendingLimit: PublicKey): TransactionInstruction {
  return multisig.instructions.multisigRemoveSpendingLimit({
    multisigPda: dao.multisig,
    spendingLimit,
    configAuthority: dao.address,
    rentCollector: dao.treasury,
  });
}

export const newCreateKey = () => Keypair.generate().publicKey;

export function isSpendingLimitIx(ix: TransactionInstruction): boolean {
  if (!ix.programId.equals(SQUADS_PROGRAM_ID)) return false;
  const d = ix.data.subarray(0, 8);
  return d.equals(ADD_LIMIT_DISC) || d.equals(REMOVE_LIMIT_DISC);
}

export function describeSpendingLimitIx(ix: TransactionInstruction): string | null {
  if (!ix.programId.equals(SQUADS_PROGRAM_ID)) return null;
  const d = ix.data.subarray(0, 8);
  if (d.equals(ADD_LIMIT_DISC)) return "Squads · add spending limit (Path B)";
  if (d.equals(REMOVE_LIMIT_DISC)) return "Squads · remove spending limit (Path B)";
  return null;
}

/**
 * The two kinds of proposal cannot be mixed: Path B refuses anything but
 * spending-limit instructions, and Path A cannot sign as the config authority.
 */
export function checkQueueMix(pending: TransactionInstruction[], adding: TransactionInstruction[]): string | null {
  const all = [...pending, ...adding];
  const limits = all.filter(isSpendingLimitIx).length;
  if (limits > 0 && limits < all.length) {
    return (
      "A spending-limit change must be its own proposal: the futarchy program executes it " +
      "with the DAO's signature and refuses any other instruction alongside. Put the Coffre " +
      "or transfer instructions in a separate proposal."
    );
  }
  return null;
}

export type SpendingLimitRow = SpendingLimit & { address: PublicKey };

/** Every spending limit of a multisig. */
export async function listSpendingLimits(connection: Connection, multisigPda: PublicKey): Promise<SpendingLimitRow[]> {
  const rows = await connection.getProgramAccounts(SQUADS_PROGRAM_ID, {
    filters: [
      { memcmp: { offset: 0, bytes: bs58(SPENDING_LIMIT_ACCOUNT_DISC) } },
      { memcmp: { offset: 8, bytes: multisigPda.toBase58() } },
    ],
  });
  return rows.map((r) => ({ address: r.pubkey, ...decodeSpendingLimit(r.account.data) }));
}

/** Does this vault transaction have to execute on Path B? */
export function isSpendingLimitProposal(vaultTx: multisig.accounts.VaultTransaction): boolean {
  const message: any = vaultTx.message;
  const squadsIndex = message.accountKeys.findIndex((k: PublicKey) => k.equals(SQUADS_PROGRAM_ID));
  if (squadsIndex < 0) return false;
  return message.instructions.every((ix: any) => {
    if (ix.programIdIndex !== squadsIndex) return false;
    const d = Buffer.from(ix.data).subarray(0, 8);
    return d.equals(ADD_LIMIT_DISC) || d.equals(REMOVE_LIMIT_DISC);
  });
}

export async function fetchVaultTransaction(connection: Connection, dao: DaoView, transactionIndex: bigint) {
  const [transactionPda] = multisig.getTransactionPda({ multisigPda: dao.multisig, index: transactionIndex });
  const vaultTx = await multisig.accounts.VaultTransaction.fromAccountAddress(connection as any, transactionPda);
  return { transactionPda, vaultTx };
}

/**
 * Path B — `execute_spending_limit_change`. The DAO account is the Squads member
 * and signs through the futarchy program, so it must NOT be flagged as a signer
 * on the outer transaction; `accountsForTransactionExecute` would flag it.
 */
export async function executeSpendingLimitChange(
  client: FutarchyClient,
  connection: Connection,
  dao: DaoView,
  proposal: PublicKey,
  squadsProposal: PublicKey,
  transactionIndex: bigint,
  payer: PublicKey,
  send: SendFn,
): Promise<string> {
  const { transactionPda, vaultTx } = await fetchVaultTransaction(connection, dao, transactionIndex);
  const { accountMetas } = await multisig.utils.accountsForTransactionExecute({
    connection: connection as any,
    message: vaultTx.message,
    ephemeralSignerBumps: [...vaultTx.ephemeralSignerBumps],
    vaultPda: dao.treasury,
    transactionPda,
  });
  const remaining = accountMetas.map((m) =>
    m.pubkey.equals(dao.address) ? { ...m, isSigner: false } : m,
  );

  const ix = await (client.futarchy as any).methods
    .executeSpendingLimitChange()
    .accounts({
      proposal,
      dao: dao.address,
      squadsProposal,
      squadsMultisig: dao.multisig,
      squadsMultisigProgram: SQUADS_PROGRAM_ID,
      vaultTransaction: transactionPda,
    })
    .remainingAccounts(remaining)
    .instruction();

  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })).add(ix);
  tx.feePayer = payer;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  return send(tx, connection, {});
}

/** Used by the Coffre forms to explain who the permissionless executor is. */
export const PERMISSIONLESS_EXECUTOR = PERMISSIONLESS_ACCOUNT.publicKey;

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58(buf: Buffer): string {
  let n = BigInt("0x" + buf.toString("hex"));
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of buf) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}
