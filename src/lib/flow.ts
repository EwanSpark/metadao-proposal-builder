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
import { sha256 } from "@noble/hashes/sha256";
import { InstructionUtils } from "@metadaoproject/programs";
import { nextTransactionIndex, type DaoView } from "./futarchy";
import {
  executeSpendingLimitChange,
  fetchVaultTransaction,
  isSpendingLimitProposal,
} from "./spendingLimit";

export type SendFn = (
  tx: Transaction,
  connection: Connection,
  opts?: { signers?: any[] },
) => Promise<string>;

/**
 * Send an Anchor methods-builder through the app's own sender instead of `.rpc()`.
 *
 * `.rpc()` confirms with web3.js `confirmTransaction`, which waits on a `signatureSubscribe`
 * WebSocket. This app talks to an HTTP-only proxy — there is no socket to subscribe on — so
 * confirmation never arrives and every call dies on the timeout with "it is unknown if it
 * succeeded or failed", even though the transaction landed in a few seconds. Sending here
 * means we hold the signature ourselves and settle it by polling, over the same HTTP path
 * as every other call.
 */
async function sendBuilder(
  builder: any,
  connection: Connection,
  payer: PublicKey,
  send: SendFn,
): Promise<string> {
  const instructions: TransactionInstruction[] = await InstructionUtils.getInstructions(builder);
  const tx = new Transaction().add(...instructions);
  tx.feePayer = payer;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  return send(tx, connection, {});
}

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

/**
 * Resume a creation that stopped part-way through step 2.
 *
 * `client.initializeProposal` runs three transactions back to back and none of them
 * is idempotent: if the first already landed, replaying it makes the System Program
 * reject the account creation with `AccountAlreadyInUse` (custom program error 0x0),
 * and the whole resume dies on a step that was already done. Ledger prompts, a wallet
 * broadcast outage, or a dropped transaction all leave exactly this state.
 *
 * So check each account first and only send what is genuinely missing. The two vaults
 * still have to go together — the program requires them in one atomic transaction.
 */
export async function resumeFutarchyProposal(
  client: FutarchyClient,
  connection: Connection,
  dao: DaoView,
  squadsProposal: PublicKey,
  payer: PublicKey,
  send: SendFn,
  say: (line: string) => void = () => {},
): Promise<PublicKey> {
  const [proposal] = getProposalAddr(client.getProgramId(), squadsProposal);

  if (await connection.getAccountInfo(proposal)) {
    say("Proposal already exists — nothing to resume.");
    return proposal;
  }

  const { question, baseVault, quoteVault } = (client as any).getProposalPdas(
    proposal,
    dao.baseMint,
    dao.quoteMint,
    dao.address,
  );

  if (await connection.getAccountInfo(question)) {
    say(`↷ question already created (${question.toBase58().slice(0, 8)}…) — skipped.`);
  } else {
    say("· creating the binary question…");
    await sendBuilder(
      (client.vaultClient as any).initializeQuestionIx(
        sha256(`Will ${proposal} pass?/FAIL/PASS`),
        proposal,
        2,
      ),
      connection,
      payer,
      send,
    );
  }

  const [baseInfo, quoteInfo] = await Promise.all([
    connection.getAccountInfo(baseVault),
    connection.getAccountInfo(quoteVault),
  ]);
  if (baseInfo && quoteInfo) {
    say("↷ both conditional vaults already exist — skipped.");
  } else if (baseInfo || quoteInfo) {
    // The pair is created atomically, so one without the other cannot happen through
    // this path. Refuse rather than send a transaction that will fail on-chain.
    throw new Error(
      "Only one of the two conditional vaults exists. This cannot be repaired here — " +
        "the program creates them atomically.",
    );
  } else {
    say("· creating both conditional vaults (one transaction)…");
    const both = client.vaultClient
      .initializeVaultIx(question, dao.baseMint, 2)
      .postInstructions(
        await InstructionUtils.getInstructions(
          client.vaultClient.initializeVaultIx(question, dao.quoteMint, 2),
        ),
      );
    await sendBuilder(both, connection, payer, send);
  }

  say("· creating the futarchy proposal…");
  const create = (client as any)
    .initializeProposalIx(squadsProposal, dao.address, dao.baseMint, dao.quoteMint, question)
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 })]);
  await sendBuilder(create, connection, payer, send);

  return proposal;
}

export function proposalAddressFor(client: FutarchyClient, squadsProposal: PublicKey): PublicKey {
  return getProposalAddr(client.getProgramId(), squadsProposal)[0];
}

/** Step 3 — stake base tokens until amount_staked >= dao.base_to_stake. */
export async function stakeToProposal(
  client: FutarchyClient,
  connection: Connection,
  dao: DaoView,
  proposal: PublicKey,
  amount: BN,
  payer: PublicKey,
  send: SendFn,
): Promise<string> {
  return sendBuilder(
    client.stakeToProposalIx({ proposal, dao: dao.address, baseMint: dao.baseMint, amount }),
    connection,
    payer,
    send,
  );
}

export async function unstakeFromProposal(
  client: FutarchyClient,
  connection: Connection,
  dao: DaoView,
  proposal: PublicKey,
  amount: BN,
  payer: PublicKey,
  send: SendFn,
): Promise<string> {
  return sendBuilder(
    client.unstakeFromProposalIx({ proposal, dao: dao.address, baseMint: dao.baseMint, amount }),
    connection,
    payer,
    send,
  );
}

/** Team-only shortcut: skips the stake requirement, switches to the team threshold. */
export async function sponsorProposal(
  client: FutarchyClient,
  connection: Connection,
  dao: DaoView,
  proposal: PublicKey,
  payer: PublicKey,
  send: SendFn,
): Promise<string> {
  return sendBuilder(
    client.sponsorProposalIx({ proposal, dao: dao.address }),
    connection,
    payer,
    send,
  );
}

/**
 * Step 4 — go live. Splits the DAO's spot reserves in half into the pass/fail
 * markets and starts the clock (duration = dao.seconds_per_proposal).
 */
export async function launchProposal(
  client: FutarchyClient,
  connection: Connection,
  dao: DaoView,
  proposal: PublicKey,
  squadsProposal: PublicKey,
  payer: PublicKey,
  send: SendFn,
): Promise<string> {
  return sendBuilder(
    client.launchProposalIx({
      proposal,
      dao: dao.address,
      baseMint: dao.baseMint,
      quoteMint: dao.quoteMint,
      squadsProposal,
    }),
    connection,
    payer,
    send,
  );
}

/** Step 5 — after duration_in_seconds. Merges the winning market back into spot. */
export async function finalizeProposal(
  client: FutarchyClient,
  connection: Connection,
  proposal: PublicKey,
  payer: PublicKey,
  send: SendFn,
): Promise<string> {
  const stored: any = await client.getProposal(proposal);
  const dao: any = await client.getDao(stored.dao);
  return sendBuilder(
    (client as any).finalizeProposalIxV2({
      squadsProposal: stored.squadsProposal,
      dao: stored.dao,
      baseMint: dao.baseMint,
      quoteMint: dao.quoteMint,
    }),
    connection,
    payer,
    send,
  );
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

export type ExecutionPath = "A" | "B";

/** Which executor a passed proposal needs, from its vault transaction's instructions. */
export async function executionPathOf(
  connection: Connection,
  dao: DaoView,
  transactionIndex: bigint,
): Promise<ExecutionPath> {
  const { vaultTx } = await fetchVaultTransaction(connection, dao, transactionIndex);
  return isSpendingLimitProposal(vaultTx) ? "B" : "A";
}

/**
 * Step 6, path-aware. Path A: `vaultTransactionExecute` by the permissionless
 * member. Path B: the futarchy program's `executeSpendingLimitChange`, which
 * makes the DAO account sign as config authority.
 */
export async function executeProposal(
  client: FutarchyClient,
  connection: Connection,
  dao: DaoView,
  proposal: PublicKey,
  squadsProposal: PublicKey,
  transactionIndex: bigint,
  payer: PublicKey,
  send: SendFn,
): Promise<{ path: ExecutionPath; signature: string }> {
  const path = await executionPathOf(connection, dao, transactionIndex);
  if (path === "B") {
    const signature = await executeSpendingLimitChange(
      client, connection, dao, proposal, squadsProposal, transactionIndex, payer, send,
    );
    return { path, signature };
  }
  const signature = await executeVaultTransaction(connection, dao, transactionIndex, payer, send);
  return { path, signature };
}
