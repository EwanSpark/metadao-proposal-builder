/**
 * The founder performance package of a launchpad DAO, read from the price-based
 * performance package program, and the memo of a proposal mandating new terms.
 *
 * What the deployed program can change (verified against the program, last deployed
 * 2026-03-22, and the `develop` source): the price oracle and the recipient, through a
 * two-party change request. It cannot move the unlock date or cap withdrawals; that
 * arrives with MetaDAO's "Performance package withdrawal limits" (programs PR #494, not
 * deployed). Until then a proposal can only *mandate* new terms, the way CARS-002 did:
 * a memo the market votes on, applied once the program supports it.
 */
import { AnchorProvider } from "@coral-xyz/anchor";
import { PriceBasedPerformancePackageClient } from "@metadaoproject/programs";
import type { Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";

export const PRICE_BASED_PP_PROGRAM_ID = new PublicKey("pbPPQH7jyKoSLu8QYs3rSY3YkDRXEBojKbTgnUg7NDS");
/** base58 of the PerformancePackage account discriminator (e492ae8379f96384). */
const PP_DISC_B58 = "fESmEUK22Xm";
/**
 * Byte offset of `token_mint` in a package with five tranches — every launchpad package
 * on mainnet has five (44 of 44 checked). Lets one filtered scan find a DAO's package.
 */
const TOKEN_MINT_OFFSET_5_TRANCHES = 299;

export type PerformancePackageView = {
  address: PublicKey;
  recipient: PublicKey;
  authority: PublicKey;
  mint: PublicKey;
  state: string;
  totalTokens: number;
  alreadyUnlocked: number;
  minUnlock: Date;
  twapDays: number;
  changesApplied: number;
  tranches: { price: number; tokens: number; unlocked: boolean }[];
};

function client(connection: Connection): any {
  const provider = new AnchorProvider(
    connection,
    {
      publicKey: PublicKey.default,
      signTransaction: async (t: any) => t,
      signAllTransactions: async (t: any) => t,
    } as any,
    { commitment: "confirmed" },
  );
  return (PriceBasedPerformancePackageClient as any).createClient({ provider });
}

/** Packages paying out `mint`. Needs getProgramAccounts, which some public RPCs refuse. */
export async function findPerformancePackages(connection: Connection, mint: PublicKey): Promise<PublicKey[]> {
  const accounts = await connection.getProgramAccounts(PRICE_BASED_PP_PROGRAM_ID, {
    dataSlice: { offset: 0, length: 0 },
    filters: [
      { memcmp: { offset: 0, bytes: PP_DISC_B58 } },
      { memcmp: { offset: TOKEN_MINT_OFFSET_5_TRANCHES, bytes: mint.toBase58() } },
    ],
  });
  return accounts.map((a) => a.pubkey);
}

export async function readPerformancePackage(
  connection: Connection,
  address: PublicKey,
  baseDecimals: number,
  quoteDecimals: number,
): Promise<PerformancePackageView> {
  const info = await connection.getAccountInfo(address);
  if (!info) throw new Error("Performance package account not found.");
  if (!info.owner.equals(PRICE_BASED_PP_PROGRAM_ID)) throw new Error("This account is not a price-based performance package.");
  const pp = await client(connection).program.account.performancePackage.fetch(address);
  const tokens = (raw: any) => Number(raw.toString()) / 10 ** baseDecimals;
  // Thresholds are AMM prices: quote per base, scaled by 1e12, in raw units.
  const price = (raw: any) => (Number(raw.toString()) / 1e12) * 10 ** (baseDecimals - quoteDecimals);
  return {
    address,
    recipient: pp.recipient,
    authority: pp.performancePackageAuthority,
    mint: pp.tokenMint,
    state: Object.keys(pp.state)[0],
    totalTokens: tokens(pp.totalTokenAmount),
    alreadyUnlocked: tokens(pp.alreadyUnlockedAmount),
    minUnlock: new Date(Number(pp.minUnlockTimestamp.toString()) * 1000),
    twapDays: Number(pp.twapLengthSeconds) / 86400,
    changesApplied: Number(pp.seqNum.toString()),
    tranches: pp.tranches.map((t: any) => ({ price: price(t.priceThreshold), tokens: tokens(t.tokenAmount), unlocked: t.isUnlocked })),
  };
}

export type PackageMandate = {
  symbol: string;
  removeCliff: boolean;
  /** Dollar cap on sales per rolling 30 days; 0 for none. */
  usdCap: number;
  /** Cap as a percentage of the whole package per rolling 30 days; 0 for none. */
  pctCap: number;
  /** How long the caps apply, counted from the change. */
  months: number;
  link?: string;
};

const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });

/** The memo of a mandate proposal, in the shape CARS-002 used. */
export function packageMandateMemo(pp: PerformancePackageView, m: PackageMandate): string {
  const lines: string[] = [];
  if (m.removeCliff) {
    lines.push(
      `- Authorize the removal of the cliff on ${m.symbol}'s performance package ${pp.address.toBase58()} ` +
        `(unlock no earlier than ${pp.minUnlock.toISOString().slice(0, 10)}); price-based unlocks over the ${pp.twapDays}-day TWAP stay unchanged.`,
    );
  }
  const caps: string[] = [];
  if (m.usdCap > 0) caps.push(`$${fmt(m.usdCap)}`);
  if (m.pctCap > 0) caps.push(`${m.pctCap}% of the package (${fmt((pp.totalTokens * m.pctCap) / 100)} ${m.symbol})`);
  if (caps.length) {
    lines.push(
      `- Authorize a change such that for ${m.months} months, no more than ${caps.join(" and no more than ")} may be sold per rolling 30 days.`,
    );
  }
  lines.push("- Mandate only: applied once the performance package program supports these terms.");
  if (m.link?.trim()) lines.push(`Full text: ${m.link.trim()}`);
  return lines.join("\n");
}

/** Largest memo a memo-only proposal can carry within the 1232-byte creation transaction. */
export const MAX_MANDATE_MEMO_BYTES = 719;
