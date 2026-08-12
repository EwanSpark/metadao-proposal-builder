/**
 * Walks every DAO in daos.snapshot.json, decodes every futarchy proposal and the
 * Squads vault transaction behind it, and classifies the instructions.
 *
 *   node scripts/survey-proposals.mjs
 *   RPC=https://… node scripts/survey-proposals.mjs
 *
 * Writes survey.json next to the script and prints an aggregate summary.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { AnchorProvider } from "@coral-xyz/anchor";
import { FutarchyClient, getProposalAddr } from "@metadaoproject/programs/futarchy";
import { Connection, PublicKey } from "@solana/web3.js";
import * as multisig from "@sqds/multisig";

const RPC = process.env.RPC ?? "https://api.mainnet-beta.solana.com";
const connection = new Connection(RPC, "confirmed");
const provider = new AnchorProvider(
  connection,
  { publicKey: PublicKey.default, signTransaction: async (t) => t, signAllTransactions: async (t) => t },
  { commitment: "confirmed" },
);
const client = FutarchyClient.createClient({ provider });

const snapshot = JSON.parse(
  readFileSync(new URL("../src/daos.snapshot.json", import.meta.url), "utf8"),
);

const PROGRAMS = {
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: "SPL Memo",
  DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M: "Jupiter DCA",
  FUTARELBfJfQ8RDGhg1wdhddq1odMAJUePHFuBYfUxKq: "futarchy",
  VLTX1ishMBbcX3rdBWGssxawAo1Q2X2qxYFYqiGodVg: "conditional_vault",
  LiQnowFbFQdYyZhF4pUbpsrZCjxRTQ1upKJxZ2VXjde: "liquidation",
  gvnr27cVeyW3AVf3acL7VCJ5WjGAphytnsgcK1feHyH: "mint_governor",
  pbPPQH7jyKoSLu8QYs3rSY3YkDRXEBojKbTgnUg7NDS: "performance_package",
  WALL8ucBuUyL46QYxwYJjidaFYhdvxUFrgvBxPshERx: "bid_wall",
  moontUzsdepotRGe5xsfip7vLPTJnVuafqdUWexVnPM: "launchpad v0.7",
  moonDJUoHteKkGATejA5bdJVwJ6V6Dg74gyqyJTx73n: "launchpad v0.8",
  cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG: "Meteora DAMM v2",
  ComputeBudget111111111111111111111111111111: "ComputeBudget",
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "Associated Token",
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "SPL Token",
  metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s: "Metaplex Metadata",
  "11111111111111111111111111111111": "System",
  SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf: "Squads",
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "Jupiter Swap",
};

// futarchy instruction discriminators, so we can name what a proposal actually calls.
const futarchyIdl = JSON.parse(
  readFileSync(new URL("../../idl-onchain-mainnet.json", import.meta.url), "utf8"),
);
const snake = (s) => s.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
const FUTARCHY_IX = new Map(
  futarchyIdl.instructions.map((i) => [
    createHash("sha256").update(`global:${snake(i.name)}`).digest().subarray(0, 8).toString("hex"),
    i.name,
  ]),
);

const SPL_TOKEN_IX = {
  3: "transfer",
  7: "mintTo",
  8: "burn",
  9: "closeAccount",
  12: "transferChecked",
  13: "mintToChecked",
  15: "burnChecked",
};

const SQUADS_NAMES = [
  "multisig_create_v2", "multisig_add_member", "multisig_remove_member",
  "multisig_change_threshold", "multisig_set_time_lock", "multisig_add_spending_limit",
  "multisig_remove_spending_limit", "multisig_set_config_authority", "multisig_set_rent_collector",
  "config_transaction_create", "config_transaction_execute", "vault_transaction_create",
  "vault_transaction_execute", "proposal_create", "proposal_approve", "proposal_reject",
  "proposal_cancel", "proposal_activate", "spending_limit_use", "batch_create",
];
const SQUADS_IX = new Map(
  SQUADS_NAMES.map((n) => [
    createHash("sha256").update(`global:${n}`).digest().subarray(0, 8).toString("hex"),
    n,
  ]),
);

const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

async function getMany(keys) {
  const out = [];
  for (const part of chunk(keys, 100)) {
    let infos;
    try {
      infos = await connection.getMultipleAccountsInfo(part);
    } catch {
      infos = [];
      for (const k of part) infos.push(await connection.getAccountInfo(k));
    }
    out.push(...infos);
  }
  return out;
}

/* ------------------------------------------------- 1. candidate proposals */

console.log(`Lecture des ${snapshot.daos.length} multisigs…`);
const multisigPdas = snapshot.daos.map(
  (d) => multisig.getMultisigPda({ createKey: new PublicKey(d.address) })[0],
);
const msInfos = await getMany(multisigPdas);

const candidates = [];
snapshot.daos.forEach((d, i) => {
  const info = msInfos[i];
  if (!info) return;
  let last;
  try {
    last = Number(multisig.accounts.Multisig.fromAccountInfo(info)[0].transactionIndex.toString());
  } catch {
    return;
  }
  for (let idx = 1; idx <= last; idx++) {
    const [squadsProposal] = multisig.getProposalPda({
      multisigPda: multisigPdas[i],
      transactionIndex: BigInt(idx),
    });
    const [proposal] = getProposalAddr(client.getProgramId(), squadsProposal);
    const [vaultTx] = multisig.getTransactionPda({
      multisigPda: multisigPdas[i],
      index: BigInt(idx),
    });
    candidates.push({ dao: d, idx, squadsProposal, proposal, vaultTx });
  }
});
console.log(`${candidates.length} transactions Squads candidates`);

/* -------------------------------------------------- 2. futarchy proposals */

const propInfos = await getMany(candidates.map((c) => c.proposal));
const found = [];
for (let i = 0; i < candidates.length; i++) {
  const info = propInfos[i];
  if (!info) continue;
  try {
    const p = await client.deserializeProposal(info);
    found.push({
      ...candidates[i],
      number: p.number,
      state: Object.keys(p.state)[0],
      isTeamSponsored: !!p.isTeamSponsored,
      durationSeconds: p.durationInSeconds,
    });
  } catch {
    /* different layout */
  }
}
console.log(`${found.length} proposals futarchy décodées`);

/* ------------------------------------------------- 3. vault transactions */

const vtInfos = await getMany(found.map((f) => f.vaultTx));
const rows = [];
for (let i = 0; i < found.length; i++) {
  const info = vtInfos[i];
  const f = found[i];
  if (!info) {
    rows.push({ ...f, instructions: null });
    continue;
  }
  let vt;
  try {
    vt = multisig.accounts.VaultTransaction.fromAccountInfo(info)[0];
  } catch {
    rows.push({ ...f, instructions: null });
    continue;
  }
  const keys = vt.message.accountKeys.map((k) => k.toBase58());
  const instructions = vt.message.instructions.map((ix) => {
    const programId = keys[ix.programIdIndex];
    const data = Buffer.from(ix.data);
    const program = PROGRAMS[programId] ?? programId.slice(0, 8) + "…";
    let label = program;
    if (program === "futarchy") {
      const name = FUTARCHY_IX.get(data.subarray(0, 8).toString("hex"));
      label = `futarchy.${name ?? "?"}`;
    } else if (program === "SPL Memo") {
      label = "SPL Memo";
    }
    if (program === "SPL Token") label = `SPL Token.${SPL_TOKEN_IX[data[0]] ?? data[0]}`;
    if (program === "Squads")
      label = `Squads.${SQUADS_IX.get(data.subarray(0, 8).toString("hex")) ?? "?" + data.subarray(0, 8).toString("hex")}`;
    return {
      program,
      label,
      memo: program === "SPL Memo" ? data.toString("utf8") : undefined,
      disc: data.subarray(0, 8).toString("hex"),
      accounts: ix.accountIndexes.length,
      dataLen: data.length,
    };
  });
  rows.push({ ...f, instructions });
}

/* ------------------------------------------------------------ 4. agrégats */

const out = rows.map((r) => ({
  dao: r.dao.symbol ?? r.dao.address.slice(0, 8),
  daoAddress: r.dao.address,
  number: r.number,
  squadsIndex: r.idx,
  state: r.state,
  teamSponsored: r.isTeamSponsored,
  durationDays: +(r.durationSeconds / 86400).toFixed(2),
  proposal: r.proposal.toBase58(),
  instructions: r.instructions,
}));
writeFileSync(new URL("./survey.json", import.meta.url), JSON.stringify(out, null, 2));

const byState = {};
const byProgram = {};
const byLabel = {};
let noIx = 0;
let memoOnly = 0;
const memos = [];

for (const r of out) {
  byState[r.state] = (byState[r.state] ?? 0) + 1;
  if (!r.instructions) {
    noIx++;
    continue;
  }
  const meaningful = r.instructions.filter((i) => i.program !== "ComputeBudget");
  if (meaningful.length === 1 && meaningful[0].program === "SPL Memo") {
    memoOnly++;
    memos.push({ dao: r.dao, n: r.number, state: r.state, text: meaningful[0].memo });
  }
  for (const ix of r.instructions) {
    byProgram[ix.program] = (byProgram[ix.program] ?? 0) + 1;
    byLabel[ix.label] = (byLabel[ix.label] ?? 0) + 1;
  }
}

const line = (o) =>
  Object.entries(o)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `  ${String(v).padStart(4)}  ${k}`)
    .join("\n");

console.log(`\n=== ${out.length} proposals sur ${new Set(out.map((r) => r.daoAddress)).size} DAO ===`);
console.log("\n-- états --\n" + line(byState));
console.log("\n-- programmes appelés (occurrences d'instructions) --\n" + line(byProgram));
console.log("\n-- instructions futarchy --\n" + line(Object.fromEntries(Object.entries(byLabel).filter(([k]) => k.startsWith("futarchy.")))));
console.log(`\n-- proposals sans vault tx lisible: ${noIx}`);
console.log(`-- proposals memo-only (mandat signalétique): ${memoOnly}`);
console.log("\n-- memos --");
for (const m of memos) console.log(`  [${m.dao} #${m.n} ${m.state}] ${JSON.stringify(m.text.slice(0, 130))}`);
console.log("\n→ détail complet dans scripts/survey.json");
