/**
 * Mesure la taille de la transaction de création (vaultTransactionCreate +
 * proposalCreate) pour différentes longueurs de memo, et dit ce qui passe.
 *
 *   node examples/size-basket-tx.mjs
 */
import { readFileSync } from "node:fs";
import { PERMISSIONLESS_ACCOUNT } from "@metadaoproject/programs";
import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
} from "@solana/web3.js";
import * as multisig from "@sqds/multisig";

const DAO = new PublicKey("GEZF81Us2ZMD9cozjEra6NXxi1tC2AdjvZXxKWcdVEgm");
const PAYER = new PublicKey("AtovZb5xYptRJghNJbuXo3Uku4Tvn6cxccGgtU9MsWys");
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const LIMIT = 1232;

const raw = JSON.parse(readFileSync(new URL("./basket-instructions.json", import.meta.url)));
const base = raw.map(
  (r) =>
    new TransactionInstruction({
      programId: new PublicKey(r.programId),
      keys: r.keys.map((k) => ({
        pubkey: new PublicKey(k.pubkey),
        isSigner: k.isSigner,
        isWritable: k.isWritable,
      })),
      data: Buffer.from(r.data, "base64"),
    }),
);

const multisigPda = multisig.getMultisigPda({ createKey: DAO })[0];
const [vault] = multisig.getVaultPda({ multisigPda, index: 0 });
const blockhash = "11111111111111111111111111111111";

function sizeOf(instructions, { withProposalCreate, withComputeBudget }) {
  const transactionMessage = new TransactionMessage({
    payerKey: vault,
    recentBlockhash: blockhash,
    instructions,
  });
  const vaultTxCreate = multisig.instructions.vaultTransactionCreate({
    multisigPda,
    transactionIndex: 1n,
    creator: PERMISSIONLESS_ACCOUNT.publicKey,
    rentPayer: PAYER,
    vaultIndex: 0,
    ephemeralSigners: 0,
    transactionMessage,
  });
  const tx = new Transaction();
  if (withComputeBudget) tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  tx.add(vaultTxCreate);
  if (withProposalCreate)
    tx.add(
      multisig.instructions.proposalCreate({
        multisigPda,
        transactionIndex: 1n,
        creator: PERMISSIONLESS_ACCOUNT.publicKey,
        rentPayer: PAYER,
      }),
    );
  tx.feePayer = PAYER;
  tx.recentBlockhash = blockhash;
  // compileMessage ne lève pas quand c'est trop gros, contrairement à serialize
  const msg = tx.compileMessage().serialize().length;
  return msg + 1 + 64 * 2; // compact-u8 du nombre de signatures + 2 signatures

}

const withMemo = (text) => {
  const ixs = base.slice(0, 3);
  if (text !== null)
    ixs.push(new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from(text, "utf8") }));
  return ixs;
};

const currentMemo = base[3] ? base[3].data.toString("utf8") : "";
console.log(`memo actuel : ${Buffer.byteLength(currentMemo, "utf8")} octets\n`);

const short = [
  "MetaDAO proposal",
  "Title: Redeploy 25% of the futarchy AMM liquidity to Omnipair",
  "Full proposal: https://REMPLACER-PAR-TON-LIEN",
].join("\n");

const cases = [
  ["actuel, tout en une tx", withMemo(currentMemo), { withProposalCreate: true, withComputeBudget: true }],
  ["actuel, sans computeBudget", withMemo(currentMemo), { withProposalCreate: true, withComputeBudget: false }],
  ["actuel, vaultTxCreate seul", withMemo(currentMemo), { withProposalCreate: false, withComputeBudget: false }],
  ["memo court, tout en une tx", withMemo(short), { withProposalCreate: true, withComputeBudget: true }],
  ["memo court, vaultTxCreate seul", withMemo(short), { withProposalCreate: false, withComputeBudget: false }],
  ["sans memo, tout en une tx", withMemo(null), { withProposalCreate: true, withComputeBudget: true }],
];

for (const [label, ixs, opts] of cases) {
  const n = sizeOf(ixs, opts);
  console.log(`${(n + " o").padStart(7)}  ${n <= LIMIT ? "✅" : "❌"}  ${label}`);
}
console.log(`\nlimite Solana : ${LIMIT} octets`);
console.log(`memo court proposé (${Buffer.byteLength(short, "utf8")} o) :\n${short}`);
