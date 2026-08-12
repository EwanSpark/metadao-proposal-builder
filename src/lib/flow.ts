import { PERMISSIONLESS_ACCOUNT } from "@metadaoproject/programs";
import { FutarchyClient, getProposalAddr } from "@metadaoproject/programs/futarchy";
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
} from "@solana/web3.js";
import * as multisig from "@sqds/multisig";
import BN from "bn.js";
import { nextTransactionIndex, type DaoView } from "./futarchy";

export type SendFn = (
  tx: Transaction,
  connection: Connection,
  opts?: { signers?: any[] },
) => Promise<string>;

export type CreateResult = {
  transactionIndex: bigint;
  squadsProposal: PublicKey;
  proposal: PublicKey;
  signature: string;
};

/**
 * Step 1 — wrap the instructions in a Squads vault transaction and open its proposal.
 *
 * NOTE: the SDK's `squadsProposalCreateTx` sets the inner message's payerKey to the
 * proposer's wallet. The vault PDA is what actually signs at execution time, so we
 * build the message here with payerKey = vault, matching the program's own tests.
 */
export async function createSquadsProposal(
  connection: Connection,
  dao: DaoView,
  instructions: TransactionInstruction[],
  payer: PublicKey,
  send: SendFn,
): Promise<{ transactionIndex: bigint; squadsProposal: PublicKey; signature: string }> {
  if (instructions.length === 0) throw new Error("No instructions to propose.");

  const transactionIndex = await nextTransactionIndex(connection, dao.multisig);
  const blockhash = (await connection.getLatestBlockhash()).blockhash;

  const transactionMessage = new TransactionMessage({
    payerKey: dao.treasury,
    recentBlockhash: blockhash,
    instructions,
  });

  const vaultTxCreate = multisig.instructions.vaultTransactionCreate({
    multisigPda: dao.multisig,
    transactionIndex,
    creator: PERMISSIONLESS_ACCOUNT.publicKey,
    rentPayer: payer,
    vaultIndex: 0,
    ephemeralSigners: 0,
    transactionMessage,
  });

  const proposalCreate = multisig.instructions.proposalCreate({
    multisigPda: dao.multisig,
    transactionIndex,
    creator: PERMISSIONLESS_ACCOUNT.publicKey,
    rentPayer: payer,
  });

  // No ComputeBudget instruction here: the default is 200k CU *per instruction*,
  // so an explicit limit would only lower it — and every byte counts, this
  // transaction carries the whole serialized inner message and caps out at 1232.
  const tx = new Transaction().add(vaultTxCreate).add(proposalCreate);
  tx.feePayer = payer;
  tx.recentBlockhash = blockhash;

  const size = tx.compileMessage().serialize().length + 1 + 64 * 2;
  if (size > 1232) {
    throw new Error(
      `Creation transaction too large: ${size} > 1232 bytes. ` +
        `Shorten the proposed instructions — a long memo is usually the culprit.`,
    );
  }

  const signature = await send(tx, connection, { signers: [PERMISSIONLESS_ACCOUNT] });

  const [squadsProposal] = multisig.getProposalPda({
    multisigPda: dao.multisig,
    transactionIndex,
  });

  return { transactionIndex, squadsProposal, signature };
}

/**
 * Step 2 — create the binary question, both conditional vaults, and the futarchy
 * proposal. The SDK sends three transactions here; the vaults must land together.
 * Result state: Draft { amount_staked: 0 }.
 */
export async function initializeFutarchyProposal(
  client: FutarchyClient,
  dao: DaoView,
  squadsProposal: PublicKey,
): Promise<PublicKey> {
  return client.initializeProposal(dao.address, squadsProposal);
}

export function proposalAddressFor(client: FutarchyClient, squadsProposal: PublicKey): PublicKey {
  return getProposalAddr(client.getProgramId(), squadsProposal)[0];
}

/** Step 3 — stake base tokens until amount_staked >= dao.base_to_stake. */
export async function stakeToProposal(
  client: FutarchyClient,
  dao: DaoView,
  proposal: PublicKey,
  amount: BN,
): Promise<string> {
  return client
    .stakeToProposalIx({ proposal, dao: dao.address, baseMint: dao.baseMint, amount })
    .rpc();
}

export async function unstakeFromProposal(
  client: FutarchyClient,
  dao: DaoView,
  proposal: PublicKey,
  amount: BN,
): Promise<string> {
  return client
    .unstakeFromProposalIx({ proposal, dao: dao.address, baseMint: dao.baseMint, amount })
    .rpc();
}

/** Team-only shortcut: skips the stake requirement, switches to the team threshold. */
export async function sponsorProposal(
  client: FutarchyClient,
  dao: DaoView,
  proposal: PublicKey,
): Promise<string> {
  return client.sponsorProposalIx({ proposal, dao: dao.address }).rpc();
}

/**
 * Step 4 — go live. Splits the DAO's spot reserves in half into the pass/fail
 * markets and starts the clock (duration = dao.seconds_per_proposal).
 */
export async function launchProposal(
  client: FutarchyClient,
  dao: DaoView,
  proposal: PublicKey,
  squadsProposal: PublicKey,
): Promise<string> {
  return client
    .launchProposalIx({
      proposal,
      dao: dao.address,
      baseMint: dao.baseMint,
      quoteMint: dao.quoteMint,
      squadsProposal,
    })
    .rpc();
}

/** Step 5 — after duration_in_seconds. Merges the winning market back into spot. */
export async function finalizeProposal(
  client: FutarchyClient,
  proposal: PublicKey,
): Promise<string> {
  return client.finalizeProposal(proposal);
}

/** Step 6 — execution is a separate top-level tx (Solana reentrancy guard). */
export async function executeVaultTransaction(
  connection: Connection,
  dao: DaoView,
  transactionIndex: bigint,
  payer: PublicKey,
  send: SendFn,
): Promise<string> {
  const { instruction } = await multisig.instructions.vaultTransactionExecute({
    connection: connection as any,
    multisigPda: dao.multisig,
    transactionIndex,
    member: PERMISSIONLESS_ACCOUNT.publicKey,
  });

  const blockhash = (await connection.getLatestBlockhash()).blockhash;
  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
    .add(instruction);
  tx.feePayer = payer;
  tx.recentBlockhash = blockhash;

  return send(tx, connection, { signers: [PERMISSIONLESS_ACCOUNT] });
}

export type ProposalStatus = {
  address: PublicKey;
  number: number;
  state: any;
  amountStaked: BN;
  squadsProposal: PublicKey;
  timestampEnqueued: BN;
  durationSeconds: number;
  secondsRemaining: number | null;
};

export async function readProposal(
  client: FutarchyClient,
  proposal: PublicKey,
): Promise<ProposalStatus | null> {
  const p: any = await client.fetchProposal(proposal);
  if (!p) return null;

  const amountStaked: BN = p.state.draft ? p.state.draft.amountStaked : new BN(0);
  const enqueued = Number(p.timestampEnqueued.toString());
  const secondsRemaining =
    enqueued > 0 ? enqueued + p.durationInSeconds - Math.floor(Date.now() / 1000) : null;

  return {
    address: proposal,
    number: p.number,
    state: p.state,
    amountStaked,
    squadsProposal: p.squadsProposal,
    timestampEnqueued: p.timestampEnqueued,
    durationSeconds: p.durationInSeconds,
    secondsRemaining,
  };
}
