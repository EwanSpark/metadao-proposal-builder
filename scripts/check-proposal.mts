// Decodes a futarchy proposal's vault transaction and simulates it as the treasury.
//   npx tsx scripts/check-proposal.mts <futarchy proposal | squads proposal | vault transaction>
// The vault cannot pay fees in a simulation (it often holds 0 SOL); a funded wallet pays
// them instead, exactly as the executor does on mainnet. Rent the instructions charge to
// the vault is still charged to the vault.
import { Connection, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import * as multisig from "@sqds/multisig";
import { makeClient, proposalStateName, loadDao } from "../src/lib/futarchy";
import { describeInstruction } from "../src/lib/actions";

const RPC = process.env.RPC ?? "https://api.mainnet-beta.solana.com";
const FEE_PAYER = new PublicKey(process.env.FEE_PAYER ?? "2KAGMaNTi3qo5zxZWNghNpMzhdmVeCFrWFeLDJUJrYcR");
const FUTARCHY = "FUTARELBfJfQ8RDGhg1wdhddq1odMAJUePHFuBYfUxKq";
const SQUADS = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";
const c = new Connection(RPC, "confirmed");
const client = makeClient(c, null);
const input = new PublicKey(process.argv[2]);
const info = await c.getAccountInfo(input);
if (!info) throw new Error("Account not found.");

let futarchyProposal: any = null, squadsProposalPda: PublicKey | null = null, vaultTxPda: PublicKey | null = null;
const disc = (info.data as Buffer).subarray(0, 8).toString("hex");
if (info.owner.toBase58() === FUTARCHY) {
  futarchyProposal = await (client as any).getProposal(input);
  squadsProposalPda = futarchyProposal.squadsProposal;
} else if (info.owner.toBase58() === SQUADS) {
  // Proposal and VaultTransaction discriminators (anchor "account:<Name>").
  if (disc === "1a5ebdbb74883521") squadsProposalPda = input;
  else vaultTxPda = input;
} else throw new Error(`Owned by ${info.owner.toBase58()}, neither futarchy nor Squads.`);

let sp: any = null;
if (squadsProposalPda) {
  sp = await multisig.accounts.Proposal.fromAccountAddress(c, squadsProposalPda);
  vaultTxPda = multisig.getTransactionPda({ multisigPda: sp.multisig, index: BigInt(sp.transactionIndex.toString()) })[0];
}
const vt = await multisig.accounts.VaultTransaction.fromAccountAddress(c, vaultTxPda!);
if (!sp) sp = await multisig.accounts.Proposal.fromAccountAddress(c, multisig.getProposalPda({ multisigPda: vt.multisig, transactionIndex: BigInt(vt.index.toString()) })[0]).catch(() => null);
const [vault] = multisig.getVaultPda({ multisigPda: vt.multisig, index: vt.vaultIndex });

if (futarchyProposal) {
  const dao = await loadDao(client, c, futarchyProposal.dao);
  console.log(`futarchy proposal #${futarchyProposal.number} · ${proposalStateName(futarchyProposal.state)} · team sponsored ${futarchyProposal.isTeamSponsored} · DAO ${dao.address.toBase58()}`);
  console.log(`DAO vote ${dao.secondsPerProposal}s, TWAP delay ${dao.twapStartDelaySeconds}s, treasury matches vault: ${dao.treasury.equals(vault)}`);
}
console.log(`squads proposal ${sp ? sp.status.__kind : "?"} · vault tx ${vaultTxPda!.toBase58()} (#${vt.index}) · address lookups ${vt.message.addressTableLookups.length}`);
console.log(`vault ${vault.toBase58()} holds ${(await c.getBalance(vault)) / 1e9} SOL`);
if (vt.message.addressTableLookups.length) console.log("⚠️ uses address lookup tables — simulation below resolves static keys only");

const k = vt.message.accountKeys, nS = vt.message.numSigners, nWS = vt.message.numWritableSigners, nWN = vt.message.numWritableNonSigners;
const isW = (i: number) => (i < nS ? i < nWS : i - nS < nWN);
const ixs = vt.message.instructions.map((ix: any) => new TransactionInstruction({
  programId: k[ix.programIdIndex],
  keys: Array.from(ix.accountIndexes as Uint8Array).map((i) => ({ pubkey: k[i], isSigner: i < nS, isWritable: isW(i) })),
  data: Buffer.from(ix.data),
}));
ixs.forEach((ix, n) => {
  console.log(`#${n + 1} ${describeInstruction(ix)}`);
  console.log(`    ${ix.programId.toBase58()} · ${ix.keys.map((x) => x.pubkey.toBase58() + (x.isSigner ? "(S)" : "") + (x.isWritable ? "(W)" : "")).join(" ")}`);
});

const writable = [...new Set(ixs.flatMap((ix) => ix.keys.filter((x) => x.isWritable).map((x) => x.pubkey.toBase58())))].slice(0, 20);
const before = await c.getMultipleAccountsInfo(writable.map((w) => new PublicKey(w)));
const msg = new TransactionMessage({ payerKey: FEE_PAYER, recentBlockhash: (await c.getLatestBlockhash()).blockhash, instructions: ixs }).compileToV0Message();
const sim = await c.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true, accounts: { encoding: "base64", addresses: writable } });
console.log(`\nSIMULATION: ${sim.value.err ? "❌ " + JSON.stringify(sim.value.err) : "✅ success"} · ${sim.value.unitsConsumed} CU`);
for (const l of sim.value.logs ?? []) if (/failed|rror|insufficient|Memo \(len/.test(l)) console.log("   " + l);
// Token balance changes on writable token accounts (amount at offset 64).
sim.value.accounts?.forEach((a, i) => {
  const b = before[i];
  const tok = (d: Buffer | undefined, owner?: string) => d && d.length >= 72 && owner && /^Token/.test(owner) ? d.readBigUInt64LE(64) : null;
  const was = tok(b?.data as Buffer, b?.owner.toBase58());
  const now = a ? tok(Buffer.from(a.data[0], "base64"), a.owner) : null;
  if (was !== now) console.log(`   ${writable[i].slice(0, 8)}… token amount ${was ?? "(none)"} → ${now ?? "(closed)"}`);
  if ((b?.lamports ?? 0) !== (a?.lamports ?? 0) && writable[i] === vault.toBase58()) console.log(`   vault lamports ${b?.lamports ?? 0} → ${a?.lamports ?? 0}`);
});
