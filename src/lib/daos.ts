import { FutarchyClient } from "@metadaoproject/programs/futarchy";
import type { Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import snapshot from "../daos.snapshot.json";

const MPL_TOKEN_METADATA = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

/** sha256("account:Dao")[0..8], base58. */
const DAO_DISCRIMINATOR_B58 = "UGeq4Q9YNpY";

export type DaoSummary = {
  address: PublicKey;
  baseMint: PublicKey;
  name: string | null;
  symbol: string | null;
  proposalCount: number;
  poolPhase: "spot" | "futarchy";
};

export function daoLabel(d: DaoSummary): string {
  const head = d.symbol ? `${d.name ?? d.symbol} (${d.symbol})` : d.address.toBase58().slice(0, 12) + "…";
  const props = d.proposalCount === 1 ? "1 proposal" : `${d.proposalCount} proposals`;
  return `${head} · ${props}${d.poolPhase === "futarchy" ? " · vote en cours" : ""}`;
}

function metadataPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), MPL_TOKEN_METADATA.toBuffer(), mint.toBuffer()],
    MPL_TOKEN_METADATA,
  )[0];
}

function readMetadataNameSymbol(data: Buffer): { name: string; symbol: string } | null {
  try {
    let o = 1 + 32 + 32; // key + update_authority + mint
    const readStr = () => {
      const len = data.readUInt32LE(o);
      o += 4;
      const s = data.subarray(o, o + len).toString("utf8").replace(/\0+$/, "").trim();
      o += len;
      return s;
    };
    const name = readStr();
    const symbol = readStr();
    return { name, symbol };
  } catch {
    return null;
  }
}

/**
 * All futarchy DAOs on the cluster. ~84 accounts of 1205 bytes on mainnet today,
 * so one getProgramAccounts is fine. Names come from Metaplex metadata and are
 * best-effort: if the RPC refuses batched reads, the list still works without them.
 */
export async function listDaos(
  connection: Connection,
  client: FutarchyClient,
): Promise<DaoSummary[]> {
  const accounts = await connection.getProgramAccounts(client.getProgramId(), {
    filters: [{ memcmp: { offset: 0, bytes: DAO_DISCRIMINATOR_B58 } }],
  });

  const summaries: DaoSummary[] = [];
  for (const { pubkey, account } of accounts) {
    try {
      const dao: any = await client.deserializeDao({ ...account, data: account.data } as any);
      summaries.push({
        address: pubkey,
        baseMint: dao.baseMint,
        name: null,
        symbol: null,
        proposalCount: dao.proposalCount,
        poolPhase: "futarchy" in dao.amm.state ? "futarchy" : "spot",
      });
    } catch {
      // Older DAO layouts (OldDao) share the program; skip what this IDL can't read.
    }
  }

  try {
    for (let i = 0; i < summaries.length; i += 50) {
      const slice = summaries.slice(i, i + 50);
      const infos = await connection.getMultipleAccountsInfo(
        slice.map((s) => metadataPda(s.baseMint)),
      );
      slice.forEach((s, j) => {
        const info = infos[j];
        if (!info) return;
        const parsed = readMetadataNameSymbol(info.data as Buffer);
        if (parsed) {
          s.name = parsed.name || null;
          s.symbol = parsed.symbol || null;
        }
      });
    }
  } catch {
    // Names are cosmetic — a restricted RPC shouldn't break the list.
  }

  return summaries.sort((a, b) => {
    if (b.proposalCount !== a.proposalCount) return b.proposalCount - a.proposalCount;
    return (a.symbol ?? "zz").localeCompare(b.symbol ?? "zz");
  });
}

/** Bundled fallback — most public RPCs refuse getProgramAccounts outright. */
export function snapshotDaos(): DaoSummary[] {
  return snapshot.daos.map((d) => ({
    address: new PublicKey(d.address),
    baseMint: new PublicKey(d.baseMint),
    name: d.name,
    symbol: d.symbol,
    proposalCount: d.proposalCount,
    poolPhase: d.poolPhase === "futarchy" ? "futarchy" : "spot",
  }));
}

export const SNAPSHOT_CAPTURED_AT: string = snapshot.capturedAt;

export type DaoListResult = {
  daos: DaoSummary[];
  source: "rpc" | "snapshot";
  reason?: string;
};

/** Live list when the RPC allows it, bundled snapshot otherwise. */
export async function loadDaoList(
  connection: Connection,
  client: FutarchyClient,
): Promise<DaoListResult> {
  try {
    return { daos: await listDaos(connection, client), source: "rpc" };
  } catch (e: any) {
    return {
      daos: snapshotDaos(),
      source: "snapshot",
      reason: e?.message ?? String(e),
    };
  }
}

/* ------------------------------------------------------------------ cache */

type Cached = { at: number; daos: { address: string; baseMint: string; name: string | null; symbol: string | null; proposalCount: number; poolPhase: "spot" | "futarchy" }[] };

const KEY = (endpoint: string) => `metadao-daos:${endpoint}`;

export function readCache(endpoint: string): DaoSummary[] | null {
  try {
    const raw = localStorage.getItem(KEY(endpoint));
    if (!raw) return null;
    const parsed: Cached = JSON.parse(raw);
    return parsed.daos.map((d) => ({
      address: new PublicKey(d.address),
      baseMint: new PublicKey(d.baseMint),
      name: d.name,
      symbol: d.symbol,
      proposalCount: d.proposalCount,
      poolPhase: d.poolPhase,
    }));
  } catch {
    return null;
  }
}

export function writeCache(endpoint: string, daos: DaoSummary[]): void {
  try {
    const payload: Cached = {
      at: Date.now(),
      daos: daos.map((d) => ({
        address: d.address.toBase58(),
        baseMint: d.baseMint.toBase58(),
        name: d.name,
        symbol: d.symbol,
        proposalCount: d.proposalCount,
        poolPhase: d.poolPhase,
      })),
    };
    localStorage.setItem(KEY(endpoint), JSON.stringify(payload));
  } catch {
    // Quota or private mode — the list just won't persist.
  }
}
