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
