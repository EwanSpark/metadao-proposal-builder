// Prints what the Spark setup needs for a DAO: vault, mint authority, params, Meteora position.
//   npx tsx scripts/dao-info.mts <daoAddress>
import { Connection, PublicKey } from "@solana/web3.js";
import { MintLayout } from "@solana/spl-token";
import { makeClient, loadDao } from "../src/lib/futarchy";
import { findMeteoraPositions } from "../src/lib/meteora";
import { readTokenMetadata } from "../src/lib/tokenMetadata";

const connection = new Connection(process.env.RPC ?? "https://api.mainnet-beta.solana.com", "confirmed");
const client = makeClient(connection, null);
const dao = await loadDao(client, connection, new PublicKey(process.argv[2] ?? "9TW2pRqcmLn5saiw2YnfUxYjhoynk8ryoTfnKM8Po3vh"));
const anyDao = dao as any;
console.log("treasury vault:", dao.treasury.toBase58());
console.log("base mint:", dao.baseMint.toBase58(), "decimals", dao.baseDecimals);
console.log("vault SOL:", (await connection.getBalance(dao.treasury)) / 1e9);
const mi = await connection.getAccountInfo(dao.baseMint);
const m = MintLayout.decode(mi!.data.subarray(0, MintLayout.span));
console.log("mint program:", mi!.owner.toBase58());
console.log("mint authority:", m.mintAuthorityOption ? new PublicKey(m.mintAuthority).toBase58() : "none", "== treasury:", m.mintAuthorityOption ? new PublicKey(m.mintAuthority).equals(dao.treasury) : false);
console.log("supply:", Number(m.supply) / 10 ** dao.baseDecimals);
console.log("params:", JSON.stringify({ proposalSeconds: anyDao.secondsPerProposal ?? anyDao.proposalLengthSeconds, twapDelay: anyDao.twapStartDelaySeconds, raw: Object.keys(anyDao).filter(k=>/second|delay|threshold|stake/i.test(k)).reduce((o,k)=>(o[k]=String(anyDao[k]),o),{} as any) }));
const md = await readTokenMetadata(connection, dao.baseMint);
console.log("metadata:", md.name, md.symbol, md.uri, "authority==treasury:", md.updateAuthority.equals(dao.treasury));
const pos = await findMeteoraPositions(connection, dao);
for (const p of pos) console.log("meteora position:", JSON.stringify({ position: p.position.toBase58(), nftMint: p.nftMint.toBase58(), nftAccount: p.nftAccount.toBase58(), pool: p.pool.toBase58(), liquidity: p.unlockedLiquidity?.toString?.() }));
if (!pos.length) console.log("no meteora position found");
