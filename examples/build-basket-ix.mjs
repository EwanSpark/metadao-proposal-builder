/**
 * Génère les 4 instructions de la proposal Basket, prêtes à coller dans
 * l'onglet « Instruction brute » du builder.
 *
 *   node examples/build-basket-ix.mjs "https://lien-vers-le-texte-complet"
 *
 * Écrit basket-instructions.json dans examples/.
 */
import { writeFileSync } from "node:fs";
import { AnchorProvider } from "@coral-xyz/anchor";
import { FutarchyClient } from "@metadaoproject/programs/futarchy";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";

const FULL_TEXT_URL = process.argv[2];
if (!FULL_TEXT_URL) {
  console.error("Usage: node examples/build-basket-ix.mjs <url-du-texte-complet>");
  process.exit(1);
}

const DAO = new PublicKey("GEZF81Us2ZMD9cozjEra6NXxi1tC2AdjvZXxKWcdVEgm");
const TREASURY = new PublicKey("ASBU3bH5EhBjC17CLWfMG8txwQSoSgrooz9CFQJzUEAB");
const DEST = new PublicKey("AtovZb5xYptRJghNJbuXo3Uku4Tvn6cxccGgtU9MsWys");
const BASKET = new PublicKey("2rNBaMg5VAr1aMNCwAPdDZVgzzdTaNDebUnNqPFNmeta");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

const LIQUIDITY_TO_WITHDRAW = "500000000000000000"; // 25 % de 2e18
const BASKET_RAW = "479000000000"; // 479 000, 6 décimales
const USDC_RAW = "382000000"; // 382, 6 décimales

// Le memo voyage dans la vault transaction, qui plafonne à 1232 octets au total.
// Le corps détaillé vit dans le document lié ; ici on garde titre + lien.
const MEMO_TEXT = [
  "MetaDAO proposal",
  "Title: Redeploy 25% of the futarchy AMM liquidity to Omnipair",
  "Full proposal: " + FULL_TEXT_URL,
].join("\n");

const connection = new Connection(process.env.RPC ?? "https://api.mainnet-beta.solana.com", "confirmed");
const provider = new AnchorProvider(
  connection,
  { publicKey: PublicKey.default, signTransaction: async (t) => t, signAllTransactions: async (t) => t },
  { commitment: "confirmed" },
);
const client = FutarchyClient.createClient({ provider });

const toJson = (ix) => ({
  programId: ix.programId.toBase58(),
  keys: ix.keys.map((k) => ({
    pubkey: k.pubkey.toBase58(),
    isSigner: k.isSigner,
    isWritable: k.isWritable,
  })),
  data: Buffer.from(ix.data).toString("base64"),
});

// 1 — withdrawLiquidity, construit depuis le programme (absent du SDK publié)
const [ammPosition] = PublicKey.findProgramAddressSync(
  [Buffer.from("amm_position"), DAO.toBuffer(), TREASURY.toBuffer()],
  client.getProgramId(),
);
const withdrawIx = await client.futarchy.methods
  .withdrawLiquidity({
    liquidityToWithdraw: new BN(LIQUIDITY_TO_WITHDRAW),
    minBaseAmount: new BN(0),
    minQuoteAmount: new BN(0),
  })
  .accounts({
    dao: DAO,
    positionAuthority: TREASURY,
    liquidityProviderBaseAccount: getAssociatedTokenAddressSync(BASKET, TREASURY, true),
    liquidityProviderQuoteAccount: getAssociatedTokenAddressSync(USDC, TREASURY, true),
    ammBaseVault: getAssociatedTokenAddressSync(BASKET, DAO, true),
    ammQuoteVault: getAssociatedTokenAddressSync(USDC, DAO, true),
    ammPosition,
    tokenProgram: TOKEN_PROGRAM_ID,
  })
  .instruction();

// 2 et 3 — transferChecked (opcode 12)
const transfer = (mint, amount, decimals) => {
  const data = Buffer.alloc(10);
  data[0] = 12;
  data.writeBigUInt64LE(BigInt(amount), 1);
  data[9] = decimals;
  return {
    programId: TOKEN_PROGRAM_ID.toBase58(),
    keys: [
      { pubkey: getAssociatedTokenAddressSync(mint, TREASURY, true).toBase58(), isSigner: false, isWritable: true },
      { pubkey: mint.toBase58(), isSigner: false, isWritable: false },
      { pubkey: getAssociatedTokenAddressSync(mint, DEST, true).toBase58(), isSigner: false, isWritable: true },
      { pubkey: TREASURY.toBase58(), isSigner: true, isWritable: false },
    ],
    data: data.toString("base64"),
  };
};

// 4 — memo, zéro compte, exactement la forme utilisée par Ranger / ZKFG
const memoIx = {
  programId: MEMO.toBase58(),
  keys: [],
  data: Buffer.from(MEMO_TEXT, "utf8").toString("base64"),
};

const all = [toJson(withdrawIx), transfer(BASKET, BASKET_RAW, 6), transfer(USDC, USDC_RAW, 6), memoIx];

writeFileSync(new URL("./basket-instructions.json", import.meta.url), JSON.stringify(all, null, 1));

console.log("--- memo ---\n" + MEMO_TEXT + "\n");
console.log(`memo: ${Buffer.byteLength(MEMO_TEXT, "utf8")} octets`);
console.log(`4 instructions écrites dans basket-instructions.json`);
for (const [i, ix] of all.entries())
  console.log(`  [${i}] ${ix.programId.slice(0, 8)}… · ${ix.keys.length} comptes · ${Buffer.from(ix.data, "base64").length}o`);
