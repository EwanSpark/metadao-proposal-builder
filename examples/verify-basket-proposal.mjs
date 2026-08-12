/**
 * Vérifie que la proposal Basket fait exactement ce qui était prévu.
 * Relit la vault transaction on-chain et compare chaque champ aux valeurs attendues.
 *
 *   node examples/verify-basket-proposal.mjs
 */
import { createHash } from "node:crypto";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import * as multisig from "@sqds/multisig";

const PROPOSAL = new PublicKey("5K42ZzoS5VfSBmcr27XqQmd9DF7c6q3WiqGpPsjfQq1a");
const DAO = new PublicKey("GEZF81Us2ZMD9cozjEra6NXxi1tC2AdjvZXxKWcdVEgm");
const TREASURY = new PublicKey("ASBU3bH5EhBjC17CLWfMG8txwQSoSgrooz9CFQJzUEAB");
const DEST = new PublicKey("AtovZb5xYptRJghNJbuXo3Uku4Tvn6cxccGgtU9MsWys");
const BASKET = new PublicKey("2rNBaMg5VAr1aMNCwAPdDZVgzzdTaNDebUnNqPFNmeta");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const FUTARCHY = new PublicKey("FUTARELBfJfQ8RDGhg1wdhddq1odMAJUePHFuBYfUxKq");
const MEMO_PROG = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

const EXPECTED_LIQUIDITY = 500000000000000000n;
const EXPECTED_BASKET = 479000000000n;
const EXPECTED_USDC = 382000000n;

const c = new Connection(process.env.RPC ?? "https://api.mainnet-beta.solana.com", "confirmed");
let pass = 0,
  fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};

const { AnchorProvider } = await import("@coral-xyz/anchor");
const { FutarchyClient } = await import("@metadaoproject/programs/futarchy");
const provider = new AnchorProvider(
  c,
  { publicKey: PublicKey.default, signTransaction: async (t) => t, signAllTransactions: async (t) => t },
  { commitment: "confirmed" },
);
const client = FutarchyClient.createClient({ provider });

const prop = await client.getProposal(PROPOSAL);
console.log("\n=== proposal ===");
check("DAO = Basket", prop.dao.equals(DAO));
check("état Draft", !!prop.state.draft, `staké ${Number(prop.state.draft?.amountStaked ?? 0) / 1e6}`);
check("durée 3 jours", prop.durationInSeconds === 3 * 86400, `${prop.durationInSeconds}s`);
check("pas team-sponsored", prop.isTeamSponsored === false);

const sp = await multisig.accounts.Proposal.fromAccountAddress(c, prop.squadsProposal);
const [vtPda] = multisig.getTransactionPda({
  multisigPda: sp.multisig,
  index: BigInt(sp.transactionIndex.toString()),
});
const vt = await multisig.accounts.VaultTransaction.fromAccountAddress(c, vtPda);
const keys = vt.message.accountKeys.map((k) => k.toBase58());
const { numSigners, numWritableSigners, numWritableNonSigners } = vt.message;
const flag = (n) => ({
  signer: n < numSigners,
  writable: n < numWritableSigners || (n >= numSigners && n < numSigners + numWritableNonSigners),
});

console.log("\n=== vault transaction ===");
check("4 instructions", vt.message.instructions.length === 4, `${vt.message.instructions.length}`);
check("vaultIndex 0", vt.vaultIndex === 0);

const ixs = vt.message.instructions;
const acc = (ix, i) => keys[ix.accountIndexes[i]];

console.log("\n=== [0] withdrawLiquidity ===");
{
  const ix = ixs[0];
  const data = Buffer.from(ix.data);
  const disc = createHash("sha256").update("global:withdraw_liquidity").digest().subarray(0, 8);
  check("programme futarchy", keys[ix.programIdIndex] === FUTARCHY.toBase58());
  check("discriminateur withdraw_liquidity", data.subarray(0, 8).equals(disc));
  const liq = data.readBigUInt64LE(8) + (data.readBigUInt64LE(16) << 64n);
  check("liquidityToWithdraw = 25%", liq === EXPECTED_LIQUIDITY, liq.toString());
  check("minBaseAmount = 0", data.readBigUInt64LE(24) === 0n);
  check("minQuoteAmount = 0", data.readBigUInt64LE(32) === 0n);
  check("compte 0 = DAO Basket", acc(ix, 0) === DAO.toBase58());
  check("compte 1 = trésorerie, signataire", acc(ix, 1) === TREASURY.toBase58() && flag(ix.accountIndexes[1]).signer);
  check(
    "destination base = ATA BASKET trésorerie",
    acc(ix, 2) === getAssociatedTokenAddressSync(BASKET, TREASURY, true).toBase58(),
  );
  check(
    "destination quote = ATA USDC trésorerie",
    acc(ix, 3) === getAssociatedTokenAddressSync(USDC, TREASURY, true).toBase58(),
  );
  const [ammPos] = PublicKey.findProgramAddressSync(
    [Buffer.from("amm_position"), DAO.toBuffer(), TREASURY.toBuffer()],
    FUTARCHY,
  );
  check("ammPosition = position du vault", ix.accountIndexes.some((n) => keys[n] === ammPos.toBase58()));
}

for (const [idx, mint, amount, dec, label] of [
  [1, BASKET, EXPECTED_BASKET, 6, "BASKET"],
  [2, USDC, EXPECTED_USDC, 6, "USDC"],
]) {
  console.log(`\n=== [${idx}] transferChecked ${label} ===`);
  const ix = ixs[idx];
  const data = Buffer.from(ix.data);
  check("programme SPL Token", keys[ix.programIdIndex] === TOKEN_PROGRAM_ID.toBase58());
  check("opcode 12 (transferChecked)", data[0] === 12);
  check(`montant = ${Number(amount) / 10 ** dec}`, data.readBigUInt64LE(1) === amount, data.readBigUInt64LE(1).toString());
  check("décimales = 6", data[9] === dec);
  check("source = ATA trésorerie", acc(ix, 0) === getAssociatedTokenAddressSync(mint, TREASURY, true).toBase58());
  check("mint correct", acc(ix, 1) === mint.toBase58());
  check("destination = ATA du Ledger", acc(ix, 2) === getAssociatedTokenAddressSync(mint, DEST, true).toBase58());
  check("autorité = trésorerie, signataire", acc(ix, 3) === TREASURY.toBase58() && flag(ix.accountIndexes[3]).signer);
}

console.log("\n=== [3] memo ===");
{
  const ix = ixs[3];
  const text = Buffer.from(ix.data).toString("utf8");
  check("programme SPL Memo", keys[ix.programIdIndex] === MEMO_PROG.toBase58());
  check("zéro compte", ix.accountIndexes.length === 0);
  check("contient un lien", /https?:\/\//.test(text));
  console.log("     " + text.replace(/\n/g, "\n     "));
}

console.log("\n=== état actuel du pool ===");
{
  const dao = await client.getDao(DAO);
  const s = dao.amm.state.spot ? dao.amm.state.spot.spot : dao.amm.state.futarchy.spot;
  const B = Number(s.baseReserves) / 1e6,
    Q = Number(s.quoteReserves) / 1e6;
  console.log(`  réserves : ${B.toLocaleString()} BASKET / ${Q.toFixed(2)} USDC — prix ${(Q / B).toFixed(6)}`);
  const share = Number(EXPECTED_LIQUIDITY) / Number(dao.amm.totalLiquidity.toString());
  console.log(`  le retrait rendrait aujourd'hui : ${(B * share).toFixed(0)} BASKET + ${(Q * share).toFixed(2)} USDC`);
  check("assez de BASKET pour le transfert", B * share >= Number(EXPECTED_BASKET) / 1e6,
    `${(B * share).toFixed(0)} vs ${Number(EXPECTED_BASKET) / 1e6} requis`);
  check("phase Spot (exécutable)", !!dao.amm.state.spot);
}

console.log(`\n${fail === 0 ? "✅ TOUT EST CONFORME" : "❌ " + fail + " ÉCART(S)"} — ${pass} vérifications passées`);
