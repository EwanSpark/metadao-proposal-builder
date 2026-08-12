import { Connection, PublicKey } from "@solana/web3.js";
import * as multisig from "@sqds/multisig";
import { AnchorProvider } from "@coral-xyz/anchor";
import { FutarchyClient } from "@metadaoproject/programs/futarchy";

const RPC = process.env.RPC ?? "https://api.mainnet-beta.solana.com";
const target = new PublicKey(process.argv[2]);

const connection = new Connection(RPC, "confirmed");
const provider = new AnchorProvider(
  connection,
  { publicKey: PublicKey.default, signTransaction: async (t) => t, signAllTransactions: async (t) => t },
  { commitment: "confirmed" },
);
const client = FutarchyClient.createClient({ provider });

const p = await client.getProposal(target);
console.log("proposal #", p.number, "état:", Object.keys(p.state)[0]);
console.log("dao          :", p.dao.toBase58());
console.log("squadsProposal:", p.squadsProposal.toBase58());

const sp = await multisig.accounts.Proposal.fromAccountAddress(connection, p.squadsProposal);
console.log("multisig     :", sp.multisig.toBase58());
console.log("txIndex      :", sp.transactionIndex.toString());
console.log("status       :", Object.keys(sp.status)[0] ?? sp.status.__kind);

const [txPda] = multisig.getTransactionPda({
  multisigPda: sp.multisig,
  index: BigInt(sp.transactionIndex.toString()),
});
const vt = await multisig.accounts.VaultTransaction.fromAccountAddress(connection, txPda);

const keys = vt.message.accountKeys.map((k) => k.toBase58());
const { numSigners, numWritableSigners, numWritableNonSigners } = vt.message;

// Squads orders accountKeys: writable signers, readonly signers, writable non-signers, readonly rest.
const flagOf = (n) => ({
  signer: n < numSigners,
  writable:
    n < numWritableSigners ||
    (n >= numSigners && n < numSigners + numWritableNonSigners),
});
const fmt = (n) => {
  const f = flagOf(n);
  return `${keys[n]}${f.signer ? " [S]" : ""}${f.writable ? " [W]" : ""}`;
};

console.log("\n--- vault transaction ---");
console.log("vaultIndex   :", vt.vaultIndex, "| comptes:", keys.length);
console.log("instructions :", vt.message.instructions.length);

for (const [i, ix] of vt.message.instructions.entries()) {
  const programId = keys[ix.programIdIndex];
  const data = Buffer.from(ix.data);
  console.log(`\n[${i}] program: ${programId}`);
  console.log("    comptes:\n      " + [...ix.accountIndexes].map(fmt).join("\n      "));
  console.log("    data(b64):", data.toString("base64"));
  console.log("    data(utf8):", JSON.stringify(data.toString("utf8")));
}
