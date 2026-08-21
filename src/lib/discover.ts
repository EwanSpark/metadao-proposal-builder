import { FutarchyClient, getProposalAddr } from "@metadaoproject/programs/futarchy";
import type { Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import * as multisig from "@sqds/multisig";
import BN from "bn.js";
import type { DaoView } from "./futarchy";

export type ProposalRow = {
  /** Squads transaction index — needed to execute the vault tx after finalization. */
  transactionIndex: bigint;
  squadsProposal: PublicKey;
  proposal: PublicKey;
  number: number;
  stateName: string;
  amountStaked: BN;
  timestampEnqueued: BN;
  durationSeconds: number;
  isTeamSponsored: boolean;
  raw: any;
};

/**
 * Every futarchy proposal is a PDA of a Squads proposal, which is itself a PDA of
 * (multisig, transactionIndex). So we can walk 1..transactionIndex and derive
 * everything deterministically — no getProgramAccounts, which public RPCs throttle
 * or refuse. Walking also hands us the transactionIndex, which the Proposal account
 * doesn't store but `vaultTransactionExecute` requires.
 */
export async function discoverProposals(
  connection: Connection,
  client: FutarchyClient,
  dao: DaoView,
): Promise<ProposalRow[]> {
  const ms = await multisig.accounts.Multisig.fromAccountAddress(
    connection as any,
    dao.multisig,
  );
  const last = BigInt(ms.transactionIndex.toString());
  if (last === 0n) return [];

  const candidates: { index: bigint; squadsProposal: PublicKey; proposal: PublicKey }[] = [];
  for (let i = 1n; i <= last; i++) {
    const [squadsProposal] = multisig.getProposalPda({
      multisigPda: dao.multisig,
      transactionIndex: i,
    });
    const [proposal] = getProposalAddr(client.getProgramId(), squadsProposal);
    candidates.push({ index: i, squadsProposal, proposal });
  }

  const rows: ProposalRow[] = [];
  for (let i = 0; i < candidates.length; i += 50) {
    const slice = candidates.slice(i, i + 50);

    // Some public RPCs refuse getMultipleAccounts — fall back to one call each.
    let infos: (Awaited<ReturnType<Connection["getAccountInfo"]>> | null)[];
    try {
      infos = await connection.getMultipleAccountsInfo(slice.map((c) => c.proposal));
    } catch {
      infos = [];
      for (const c of slice) infos.push(await connection.getAccountInfo(c.proposal));
    }

    for (let j = 0; j < slice.length; j++) {
      const info = infos[j];
      if (!info) continue; // Squads tx with no futarchy proposal on top of it.
      let decoded: any;
      try {
        decoded = await client.deserializeProposal(info as any);
      } catch {
        continue;
      }
      rows.push({
        transactionIndex: slice[j].index,
        squadsProposal: slice[j].squadsProposal,
        proposal: slice[j].proposal,
        number: decoded.number,
        stateName: Object.keys(decoded.state)[0] ?? "unknown",
        amountStaked: decoded.state.draft ? decoded.state.draft.amountStaked : new BN(0),
        timestampEnqueued: decoded.timestampEnqueued,
        durationSeconds: decoded.durationInSeconds,
        isTeamSponsored: !!decoded.isTeamSponsored,
        raw: decoded,
      });
    }
  }

  return rows.sort((a, b) => b.number - a.number);
}

/** Batched read with a per-account fallback — some public RPCs refuse getMultipleAccounts. */
async function readMany(connection: Connection, keys: PublicKey[]) {
  try {
    return await connection.getMultipleAccountsInfo(keys);
  } catch {
    const out = [];
    for (const k of keys) out.push(await connection.getAccountInfo(k));
    return out;
  }
}

export type UnfinishedCreation = {
  transactionIndex: bigint;
  squadsProposal: PublicKey;
  /** The address the futarchy proposal will have once step 2 completes. */
  proposal: PublicKey;
  /** Programs the wrapped instructions call — the only way to tell whose creation this is. */
  programs: string[];
  instructionCount: number;
  /** How much of step 2 already landed, so you can see what resuming will sign. */
  hasQuestion: boolean;
  hasVaults: boolean;
  /** Transactions still needed to finish. */
  remaining: number;
};

/**
 * Creations that stopped half-way: the Squads vault transaction and proposal exist,
 * but no futarchy proposal sits on top of them.
 *
 * Creating a proposal takes two steps that cannot be one transaction. If the second
 * one never lands — a rejected signature, a Ledger timeout, an RPC error — the Squads
 * half stays on-chain and the proposal is invisible everywhere, because every UI
 * (this one included) lists futarchy proposals, not Squads transactions. Starting
 * over would strand it for good at its index and open a new one.
 *
 * Step 2 only needs the Squads proposal address, which already exists, so these are
 * all resumable.
 */
export async function discoverUnfinished(
  connection: Connection,
  client: FutarchyClient,
  dao: DaoView,
): Promise<UnfinishedCreation[]> {
  const ms = await multisig.accounts.Multisig.fromAccountAddress(
    connection as any,
    dao.multisig,
  );
  const last = BigInt(ms.transactionIndex.toString());
  if (last === 0n) return [];

  const candidates: UnfinishedCreation[] = [];
  for (let i = 1n; i <= last; i++) {
    const [squadsProposal] = multisig.getProposalPda({
      multisigPda: dao.multisig,
      transactionIndex: i,
    });
    const [proposal] = getProposalAddr(client.getProgramId(), squadsProposal);
    candidates.push({
      transactionIndex: i,
      squadsProposal,
      proposal,
      programs: [],
      instructionCount: 0,
      hasQuestion: false,
      hasVaults: false,
      remaining: 3,
    });
  }

  // Missing futarchy proposal…
  const missing: UnfinishedCreation[] = [];
  for (let i = 0; i < candidates.length; i += 50) {
    const slice = candidates.slice(i, i + 50);
    const infos = await readMany(connection, slice.map((c) => c.proposal));
    slice.forEach((c, j) => {
      if (!infos[j]) missing.push(c);
    });
  }
  if (missing.length === 0) return [];

  // …but an existing Squads proposal. Anything else is just an unused index.
  const unfinished: UnfinishedCreation[] = [];
  for (let i = 0; i < missing.length; i += 50) {
    const slice = missing.slice(i, i + 50);
    const infos = await readMany(connection, slice.map((c) => c.squadsProposal));
    slice.forEach((c, j) => {
      if (infos[j]) unfinished.push(c);
    });
  }

  // What each one would propose. A DAO's multisig index is shared, so a stalled entry
  // may belong to somebody else entirely — finishing it would put *their* instructions
  // to a vote under your name. The programs are what let you tell them apart.
  for (let i = 0; i < unfinished.length; i += 50) {
    const slice = unfinished.slice(i, i + 50);
    const infos = await readMany(
      connection,
      slice.map(
        (c) =>
          multisig.getTransactionPda({
            multisigPda: dao.multisig,
            index: c.transactionIndex,
          })[0],
      ),
    );
    slice.forEach((c, j) => {
      const info = infos[j];
      if (!info) return;
      try {
        const [vt] = multisig.accounts.VaultTransaction.fromAccountInfo(info as any);
        c.instructionCount = vt.message.instructions.length;
        c.programs = [
          ...new Set(
            vt.message.instructions.map((ix: any) =>
              vt.message.accountKeys[ix.programIdIndex].toBase58(),
            ),
          ),
        ];
      } catch {
        // Unknown layout — leave it unlabelled rather than guessing.
      }
    });
  }

  // How far step 2 got. It runs as three transactions and none is idempotent, so
  // knowing which already landed is what makes a resume safe — and it tells apart two
  // attempts at the same proposal, one of which may be a single transaction from done.
  for (const u of unfinished) {
    try {
      const pdas = (client as any).getProposalPdas(
        u.proposal,
        dao.baseMint,
        dao.quoteMint,
        dao.address,
      );
      const [q, bv, qv] = await readMany(connection, [pdas.question, pdas.baseVault, pdas.quoteVault]);
      u.hasQuestion = !!q;
      u.hasVaults = !!bv && !!qv;
      u.remaining = (u.hasQuestion ? 0 : 1) + (u.hasVaults ? 0 : 1) + 1;
    } catch {
      // Leave the default: assume nothing landed rather than claim progress.
    }
  }

  return unfinished.sort((a, b) => Number(a.transactionIndex - b.transactionIndex));
}

/**
 * Resolve a proposal back to its Squads transaction index.
 *
 * `retries` matters right after creation: the write is confirmed, but a public
 * RPC behind a load balancer can route the read to a node that hasn't caught up,
 * which surfaces as "Account does not exist or has no data".
 */
export async function resolveProposal(
  client: FutarchyClient,
  connection: Connection,
  proposal: PublicKey,
  retries = 0,
): Promise<ProposalRow> {
  for (let i = 0; i < retries; i++) {
    if (await client.fetchProposal(proposal)) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  const decoded: any = await client.getProposal(proposal);
  const sp = await multisig.accounts.Proposal.fromAccountAddress(
    connection as any,
    decoded.squadsProposal,
  );
  return {
    transactionIndex: BigInt(sp.transactionIndex.toString()),
    squadsProposal: decoded.squadsProposal,
    proposal,
    number: decoded.number,
    stateName: Object.keys(decoded.state)[0] ?? "unknown",
    amountStaked: decoded.state.draft ? decoded.state.draft.amountStaked : new BN(0),
    timestampEnqueued: decoded.timestampEnqueued,
    durationSeconds: decoded.durationInSeconds,
    isTeamSponsored: !!decoded.isTeamSponsored,
    raw: decoded,
  };
}

export function secondsRemaining(row: ProposalRow): number | null {
  const enqueued = Number(row.timestampEnqueued.toString());
  if (enqueued === 0) return null;
  return enqueued + row.durationSeconds - Math.floor(Date.now() / 1000);
}

export function formatDuration(seconds: number): string {
  if (seconds <= 0) return "elapsed";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d} j ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  return `${m} min`;
}
