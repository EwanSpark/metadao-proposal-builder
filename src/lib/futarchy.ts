import { AnchorProvider } from "@coral-xyz/anchor";
import { FutarchyClient } from "@metadaoproject/programs/futarchy";
import { getMint } from "@solana/spl-token";
import type { Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import * as multisig from "@sqds/multisig";
import BN from "bn.js";

export type AnchorWalletLike = {
  publicKey: PublicKey;
  signTransaction: any;
  signAllTransactions: any;
};

/** Lets you inspect a DAO before connecting. Any signing attempt throws. */
const READ_ONLY_WALLET: AnchorWalletLike = {
  publicKey: PublicKey.default,
  signTransaction: () => {
    throw new Error("Connect a wallet to sign.");
  },
  signAllTransactions: () => {
    throw new Error("Connect a wallet to sign.");
  },
};

export function makeClient(
  connection: Connection,
  wallet: AnchorWalletLike | null,
): FutarchyClient {
  const provider = new AnchorProvider(connection, (wallet ?? READ_ONLY_WALLET) as any, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  return FutarchyClient.createClient({ provider });
}

export type PoolView = { base: BN; quote: BN };

export type DaoView = {
  address: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseDecimals: number;
  quoteDecimals: number;
  multisig: PublicKey;
  treasury: PublicKey;
  proposalCount: number;
  baseToStake: BN;
  passThresholdBps: number;
  teamSponsoredPassThresholdBps: number;
  secondsPerProposal: number;
  twapStartDelaySeconds: number;
  minBaseFutarchicLiquidity: BN;
  minQuoteFutarchicLiquidity: BN;
  teamAddress: PublicKey;
  /** Spot = idle. Futarchy = a proposal is live and the pool is split. */
  poolPhase: "spot" | "futarchy";
  spot: PoolView;
  /** Spot price in quote units per base unit, decimal-adjusted. */
  spotPrice: number | null;
  raw: any;
};

function poolOf(p: any): PoolView {
  return { base: p.baseReserves as BN, quote: p.quoteReserves as BN };
}

export async function loadDao(
  client: FutarchyClient,
  connection: Connection,
  address: PublicKey,
): Promise<DaoView> {
  const dao: any = await client.getDao(address);

  const [baseMintInfo, quoteMintInfo] = await Promise.all([
    getMint(connection, dao.baseMint),
    getMint(connection, dao.quoteMint),
  ]);

  // Anchor enums decode to a single camelCase key.
  const state = dao.amm.state;
  const poolPhase: "spot" | "futarchy" = "futarchy" in state ? "futarchy" : "spot";
  const spot = poolOf(poolPhase === "spot" ? state.spot.spot : state.futarchy.spot);

  let spotPrice: number | null = null;
  if (!spot.base.isZero()) {
    const scale = 10 ** (baseMintInfo.decimals - quoteMintInfo.decimals);
    spotPrice = (Number(spot.quote.toString()) / Number(spot.base.toString())) * scale;
  }

  const multisigPda = multisig.getMultisigPda({ createKey: address })[0];
  const [treasury] = multisig.getVaultPda({ multisigPda, index: 0 });

  return {
    address,
    baseMint: dao.baseMint,
    quoteMint: dao.quoteMint,
    baseDecimals: baseMintInfo.decimals,
    quoteDecimals: quoteMintInfo.decimals,
    multisig: multisigPda,
    treasury,
    proposalCount: dao.proposalCount,
    baseToStake: dao.baseToStake,
    passThresholdBps: dao.passThresholdBps,
    teamSponsoredPassThresholdBps: dao.teamSponsoredPassThresholdBps,
    secondsPerProposal: dao.secondsPerProposal,
    twapStartDelaySeconds: dao.twapStartDelaySeconds,
    minBaseFutarchicLiquidity: dao.minBaseFutarchicLiquidity,
    minQuoteFutarchicLiquidity: dao.minQuoteFutarchicLiquidity,
    teamAddress: dao.teamAddress,
    poolPhase,
    spot,
    spotPrice,
    raw: dao,
  };
}

/** Next Squads transaction index for this DAO's multisig. */
export async function nextTransactionIndex(
  connection: Connection,
  multisigPda: PublicKey,
): Promise<bigint> {
  const ms = await multisig.accounts.Multisig.fromAccountAddress(connection as any, multisigPda);
  return BigInt(ms.transactionIndex.toString()) + 1n;
}

export function uiToRaw(amount: string, decimals: number): BN {
  const [whole, frac = ""] = amount.trim().split(".");
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return new BN((whole || "0") + padded);
}

export function rawToUi(amount: BN, decimals: number, maxFrac = 6): string {
  const s = amount.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).slice(0, maxFrac).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

export function proposalStateName(state: any): string {
  const key = Object.keys(state ?? {})[0] ?? "unknown";
  if (key === "draft") {
    const staked = state.draft.amountStaked as BN;
    return `Draft (staked: ${staked.toString()})`;
  }
  return key.charAt(0).toUpperCase() + key.slice(1);
}
