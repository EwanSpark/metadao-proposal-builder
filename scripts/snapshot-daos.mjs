/**
 * Regenerates src/daos.snapshot.json — the fallback DAO list used when the RPC
 * refuses getProgramAccounts (most public endpoints do).
 *
 *   node scripts/snapshot-daos.mjs            # mainnet
 *   RPC=https://… node scripts/snapshot-daos.mjs
 */
import { writeFileSync } from "node:fs";
import { AnchorProvider } from "@coral-xyz/anchor";
import { FutarchyClient } from "@metadaoproject/programs/futarchy";
import { Connection, PublicKey } from "@solana/web3.js";

const RPC = process.env.RPC ?? "https://api.mainnet-beta.solana.com";
const MPL = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const DAO_DISCRIMINATOR_B58 = "UGeq4Q9YNpY"; // sha256("account:Dao")[0..8]

const connection = new Connection(RPC, "confirmed");
const provider = new AnchorProvider(
  connection,
  { publicKey: PublicKey.default, signTransaction: async (t) => t, signAllTransactions: async (t) => t },
  { commitment: "confirmed" },
);
const client = FutarchyClient.createClient({ provider });

const accounts = await connection.getProgramAccounts(client.getProgramId(), {
  filters: [{ memcmp: { offset: 0, bytes: DAO_DISCRIMINATOR_B58 } }],
});
console.log(`${accounts.length} comptes Dao`);

const daos = [];
for (const { pubkey, account } of accounts) {
  try {
    const dao = await client.deserializeDao(account);
    daos.push({
      address: pubkey.toBase58(),
      baseMint: dao.baseMint.toBase58(),
      name: null,
      symbol: null,
      proposalCount: dao.proposalCount,
      poolPhase: "futarchy" in dao.amm.state ? "futarchy" : "spot",
    });
  } catch (e) {
    console.warn("skip", pubkey.toBase58(), e.message);
  }
}

for (let i = 0; i < daos.length; i += 50) {
  const slice = daos.slice(i, i + 50);
  const pdas = slice.map(
    (d) =>
      PublicKey.findProgramAddressSync(
        [Buffer.from("metadata"), MPL.toBuffer(), new PublicKey(d.baseMint).toBuffer()],
        MPL,
      )[0],
  );
  const infos = await connection.getMultipleAccountsInfo(pdas);
  slice.forEach((d, j) => {
    const info = infos[j];
    if (!info) return;
    let o = 1 + 32 + 32;
    const rd = () => {
      const len = info.data.readUInt32LE(o);
      o += 4;
      const s = info.data.subarray(o, o + len).toString("utf8").replace(/\0+$/, "").trim();
      o += len;
      return s;
    };
    d.name = rd() || null;
    d.symbol = rd() || null;
  });
}

daos.sort((a, b) =>
  b.proposalCount !== a.proposalCount
    ? b.proposalCount - a.proposalCount
    : (a.symbol ?? "zz").localeCompare(b.symbol ?? "zz"),
);

const out = { cluster: "mainnet-beta", capturedAt: new Date().toISOString(), daos };
writeFileSync(new URL("../src/daos.snapshot.json", import.meta.url), JSON.stringify(out, null, 2));
console.log(`✅ ${daos.length} DAO écrits (${daos.filter((d) => d.symbol).length} nommés)`);
