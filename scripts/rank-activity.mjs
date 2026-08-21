/**
 * Ranks proposals by market activity: number of conditional swaps and quote volume.
 *
 * Both are read from the chain rather than from metadao.fi, which only exposes a
 * volume figure on each proposal page and nothing at all for trade counts.
 *
 *   node scripts/rank-activity.mjs count    # phase 1 — signatures per proposal
 *   node scripts/rank-activity.mjs detail   # phase 2 — exact swaps + volume for the quietest
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { AnchorProvider } from "@coral-xyz/anchor";
import { FutarchyClient, getProposalAddr } from "@metadaoproject/programs/futarchy";
import { Connection, PublicKey } from "@solana/web3.js";
import * as multisig from "@sqds/multisig";

const RPC = process.env.RPC ?? "https://api.mainnet-beta.solana.com";
const OUT = new URL("./activity.json", import.meta.url);
const SWAP_DISC = createHash("sha256")
  .update("global:conditional_swap")
  .digest()
  .subarray(0, 8)
  .toString("hex");

const connection = new Connection(RPC, "confirmed");
const provider = new AnchorProvider(
  connection,
  { publicKey: PublicKey.default, signTransaction: async (t) => t, signAllTransactions: async (t) => t },
  { commitment: "confirmed" },
);
const client = FutarchyClient.createClient({ provider });

/** Public RPCs answer 429 under any real load; back off instead of losing the run. */
async function retry(fn, label, tries = 8) {
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (i === tries - 1) throw new Error(`${label}: ${msg.slice(0, 90)}`);
      await new Promise((r) => setTimeout(r, 400 * 2 ** i));
    }
  }
}

const snapshot = JSON.parse(readFileSync(new URL("../src/daos.snapshot.json", import.meta.url)));
/**
 * "Legit" = a real project, not a sandbox. The launchpad-raise flag alone is too
 * strict — ZKLSOL, Loyal and Flash.Trade all ran real markets with an empty treasury
 * and no tracked raise. So take every DAO that has proposals and drop the DAOs whose
 * own name says they are tests.
 */
const TEST_DAO = /^(test|preprod|tstavi|test30|kiduna)/i;
const official = snapshot.daos.filter(
  (d) => d.proposalCount > 0 && !TEST_DAO.test(d.name ?? d.symbol ?? ""),
);

async function legitProposals() {
  const out = [];
  for (const d of official) {
    const dao = new PublicKey(d.address);
    const [ms] = multisig.getMultisigPda({ createKey: dao });
    let last;
    try {
      const acc = await retry(
        () => multisig.accounts.Multisig.fromAccountAddress(connection, ms),
        `multisig ${d.symbol}`,
      );
      last = BigInt(acc.transactionIndex.toString());
    } catch {
      continue;
    }
    for (let i = 1n; i <= last; i++) {
      const [sq] = multisig.getProposalPda({ multisigPda: ms, transactionIndex: i });
      const [proposal] = getProposalAddr(client.getProgramId(), sq);
      out.push({ dao: d.symbol ?? d.name, daoAddress: d.address, index: Number(i), proposal: proposal.toBase58() });
    }
  }
  // Keep only the indices that actually carry a futarchy proposal.
  const kept = [];
  for (let i = 0; i < out.length; i += 100) {
    const slice = out.slice(i, i + 100);
    const pending = [];
    const infos = await retry(
      () => connection.getMultipleAccountsInfo(slice.map((s) => new PublicKey(s.proposal))),
      "batch proposals",
    );
    slice.forEach((s, j) => {
      if (!infos[j]) return;
      pending.push(
        client
          .deserializeProposal(infos[j])
          .then((d) => kept.push({ ...s, number: d.number, state: Object.keys(d.state)[0] }))
          .catch(() => {}),
      );
    });
    await Promise.all(pending);
    process.stderr.write(`  proposals ${kept.length}\r`);
  }
  return kept;
}

async function signatureCount(address, cap = 2000) {
  let before, total = 0, oldest = null;
  while (total < cap) {
    const page = await retry(
      () => connection.getSignaturesForAddress(new PublicKey(address), { limit: 1000, before }),
      `sigs ${address.slice(0, 8)}`,
    );
    total += page.length;
    if (page.length) oldest = page[page.length - 1].signature;
    if (page.length < 1000) break;
    before = oldest;
  }
  return total;
}

const mode = process.argv[2] ?? "count";

if (mode === "count") {
  const props = await legitProposals();
  console.log(`\n${props.length} proposals across ${official.length} legit DAOs`);
  const launched = props.filter((p) => p.state !== "draft");
  console.log(`${launched.length} launched (draft never opens a market)\n`);
  const rows = [];
  for (const p of launched) {
    const n = await signatureCount(p.proposal);
    rows.push({ ...p, signatures: n });
    process.stderr.write(`  ${rows.length}/${launched.length}  ${p.dao} #${p.number} → ${n}\n`);
  }
  rows.sort((a, b) => a.signatures - b.signatures);
  writeFileSync(OUT, JSON.stringify({ capturedAt: new Date().toISOString(), rows }, null, 2));
  console.log("\nles 15 plus calmes par nombre de transactions :");
  for (const r of rows.slice(0, 15))
    console.log(`  ${String(r.signatures).padStart(5)}  ${r.dao} #${r.number} (${r.state})  ${r.proposal}`);
}

if (mode === "detail") {
  const { rows } = JSON.parse(readFileSync(OUT));
  // Crimera has no page on metadao.fi (404) — it is not one of their listed projects.
  const NOT_LISTED = /^CRIME$/i;
  const candidates = rows.filter((r) => !NOT_LISTED.test(r.dao)).slice(0, Number(process.argv[3] ?? 12));

  console.log("proposal                         trades   volume (quote)   état");
  const detailed = [];
  for (const r of candidates) {
    const proposal = new PublicKey(r.proposal);
    const stored = await retry(() => client.getProposal(proposal), `proposal ${r.dao}`);
    const dao = await retry(() => client.getDao(stored.dao), `dao ${r.dao}`);
    const pdas = client.getProposalPdas(proposal, dao.baseMint, dao.quoteMint, stored.dao);
    const quoteMints = new Set([pdas.passQuoteMint.toBase58(), pdas.failQuoteMint.toBase58()]);
    const dec = (await retry(() => connection.getParsedAccountInfo(dao.quoteMint), "quote mint"))
      .value.data.parsed.info.decimals;

    let before, trades = 0, volume = 0n, scanned = 0;
    for (;;) {
      const page = await retry(
        () => connection.getSignaturesForAddress(proposal, { limit: 1000, before }),
        "sigs",
      );
      for (const s of page) {
        if (s.err) continue;
        const tx = await retry(
          () => connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }),
          "tx",
        );
        scanned++;
        if (!tx) continue;
        const keys = tx.transaction.message.getAccountKeys({
          accountKeysFromLookups: tx.meta.loadedAddresses,
        });
        const isSwap = tx.transaction.message.compiledInstructions.some(
          (i) => Buffer.from(i.data).subarray(0, 8).toString("hex") === SWAP_DISC,
        );
        if (!isSwap) continue;
        trades++;
        // Quote moved by the trade: the conditional quote leaving or entering the AMM.
        const pre = new Map(
          (tx.meta.preTokenBalances ?? [])
            .filter((b) => quoteMints.has(b.mint))
            .map((b) => [b.accountIndex, BigInt(b.uiTokenAmount.amount)]),
        );
        let moved = 0n;
        for (const b of tx.meta.postTokenBalances ?? []) {
          if (!quoteMints.has(b.mint)) continue;
          const d = BigInt(b.uiTokenAmount.amount) - (pre.get(b.accountIndex) ?? 0n);
          if (d > 0n) moved += d;
        }
        volume += moved / 2n; // each unit shows up once leaving and once arriving
      }
      if (page.length < 1000) break;
      before = page[page.length - 1].signature;
    }
    const vol = Number(volume) / 10 ** dec;
    detailed.push({ ...r, trades, volume: vol, scanned });
    console.log(
      `${(r.dao + " #" + r.number).padEnd(18)} ${String(trades).padStart(6)}   ${vol
        .toFixed(2)
        .padStart(14)}   ${r.state}`,
    );
  }
  detailed.sort((a, b) => a.volume - b.volume || a.trades - b.trades);
  writeFileSync(new URL("./activity-detail.json", import.meta.url), JSON.stringify(detailed, null, 2));
}
