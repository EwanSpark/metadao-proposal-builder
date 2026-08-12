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

/**
 * A DAO counts as a real project when it came out of a launchpad raise above this
 * threshold. On mainnet the gap is unambiguous: real projects raised $10k or more,
 * every sandbox and test launch raised $100 or less.
 */
const LAUNCHPADS = [
  "MooNyh4CBUYEKyXVnjGYQ8mEiJDpGvJMdvrZx1iGeHV", // v0.6
  "moontUzsdepotRGe5xsfip7vLPTJnVuafqdUWexVnPM", // v0.7
  "moonDJUoHteKkGATejA5bdJVwJ6V6Dg74gyqyJTx73n", // v0.8
];
const MIN_RAISE_USDC = 5_000;
const MIN_TREASURY_USDC = 1_000;

/** Walks every launchpad and returns { daoAddress: raisedUsdc }. */
async function raisesByDao(connection) {
  const { createHash } = await import("node:crypto");
  const bs58 = (await import("bs58")).default;
  const disc = createHash("sha256").update("account:Launch").digest().subarray(0, 8);
  const out = {};
  for (const prog of LAUNCHPADS) {
    let accs = [];
    try {
      accs = await connection.getProgramAccounts(new PublicKey(prog), {
        filters: [{ memcmp: { offset: 0, bytes: bs58.encode(disc) } }],
      });
    } catch {
      continue; // programme absent ou RPC restrictif
    }
    for (const { account } of accs) {
      try {
        const raw = account.data;
        let o = 8 + 1 + 8 + 8;
        o += 4 + 32 * raw.readUInt32LE(o);
        o += 32 + 32 + 1 + 32 * 4;
        const skipOpt = (size) => { o += raw[o] === 0 ? 1 : 1 + size; };
        skipOpt(8); skipOpt(8);
        o += 8 + 1 + 8 + 4;
        const readOptPk = () => {
          if (raw[o] === 0) { o += 1; return null; }
          const v = new PublicKey(raw.subarray(o + 1, o + 33)).toBase58();
          o += 33;
          return v;
        };
        const dao = readOptPk();
        readOptPk();
        o += 32 + 8 + 1 + 32;
        const raised = Number(raw.readBigUInt64LE(o)) / 1e6;
        if (dao && Number.isFinite(raised)) out[dao] = Math.max(out[dao] ?? 0, raised);
      } catch {
        // layout inconnu sur une version plus ancienne : on ignore ce launch
      }
    }
  }
  return out;
}

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

const raises = await raisesByDao(connection);
console.log(`${Object.keys(raises).length} DAO rattachés à un launch`);

/**
 * Second signal: a real project holds a real treasury. Older launchpad versions
 * store their Launch differently and slip past the raise check, but their DAOs
 * still hold the USDC they raised.
 */
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const multisig = await import("@sqds/multisig");
const treasuryUsdc = {};
for (const { pubkey } of accounts) {
  const ms = multisig.getMultisigPda({ createKey: pubkey })[0];
  const [vault] = multisig.getVaultPda({ multisigPda: ms, index: 0 });
  try {
    const res = await connection.getParsedTokenAccountsByOwner(vault, { mint: USDC });
    treasuryUsdc[pubkey.toBase58()] = Number(
      res.value[0]?.account.data.parsed.info.tokenAmount.uiAmountString ?? 0,
    );
  } catch {
    treasuryUsdc[pubkey.toBase58()] = 0;
  }
}
console.log(`trésoreries lues : ${Object.values(treasuryUsdc).filter((v) => v > 0).length} non vides`);

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
      raised: Math.round(raises[pubkey.toBase58()] ?? 0),
      treasury: Math.round(treasuryUsdc[pubkey.toBase58()] ?? 0),
      official:
        (raises[pubkey.toBase58()] ?? 0) >= MIN_RAISE_USDC ||
        (treasuryUsdc[pubkey.toBase58()] ?? 0) >= MIN_TREASURY_USDC,
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
console.log(
  `✅ ${daos.length} DAO écrits — ${daos.filter((d) => d.official).length} officiels, ` +
    `${daos.filter((d) => d.symbol).length} nommés`,
);
