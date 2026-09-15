/**
 * Coffre TypeScript client (mirror of Spark/EscrowPokemon/client; keep in sync).
 *
 * Builds every instruction of the program, derives all PDAs and decodes the
 * external accounts the UI needs (Collector Crypt `Market` / `Listing`,
 * Squads `SpendingLimit`). No RPC calls happen while building instructions.
 */
import { AnchorProvider, BN, Program, type Provider } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import IDL_JSON from "./coffre.idl.json";
import type { Coffre as CoffreIdl } from "./coffre.types";

export type { CoffreIdl };
export const IDL = IDL_JSON as CoffreIdl;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const COFFRE_PROGRAM_ID = new PublicKey(IDL_JSON.address);
export const SQUADS_PROGRAM_ID = new PublicKey(
  "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf"
);
export const MARKETPLACE_PROGRAM_ID = new PublicKey(
  "CcmRKTuZCGJBWQwMHvDYApBRvSZNHqGJXkznqpDTSQUr"
);
export const MPL_TOKEN_METADATA_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);
export const MAINNET_USDC = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
);
/** The Collector Crypt Standard-NFT collection whitelisted on mainnet (2026-09). */
export const COLLECTOR_CRYPT_STANDARD_NFT_COLLECTION = new PublicKey(
  "CCryptWBYktukHDQ2vHGtVcmtjXxYzvw8XNVY64YN2Yf"
);

// ---------------------------------------------------------------------------
// PDAs
// ---------------------------------------------------------------------------

export const ata = (mint: PublicKey, owner: PublicKey) =>
  getAssociatedTokenAddressSync(mint, owner, true);

export function coffrePda(
  multisig: PublicKey,
  programId = COFFRE_PROGRAM_ID
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("coffre"), multisig.toBuffer()],
    programId
  )[0];
}
export function cardPda(
  coffre: PublicKey,
  mint: PublicKey,
  programId = COFFRE_PROGRAM_ID
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("card"), coffre.toBuffer(), mint.toBuffer()],
    programId
  )[0];
}
export function squadsVaultPda(multisig: PublicKey, index = 0): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("multisig"),
      multisig.toBuffer(),
      Buffer.from("vault"),
      Buffer.from([index]),
    ],
    SQUADS_PROGRAM_ID
  )[0];
}
export const MARKET_PDA = PublicKey.findProgramAddressSync(
  [Buffer.from("market")],
  MARKETPLACE_PROGRAM_ID
)[0];
export function whitelistEntryPda(collection: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("whitelist_entry"),
      MARKET_PDA.toBuffer(),
      Buffer.from("StandardNFT"),
      collection.toBuffer(),
    ],
    MARKETPLACE_PROGRAM_ID
  )[0];
}
export function listingPda(asset: PublicKey, seller: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("listing"), asset.toBuffer(), seller.toBuffer()],
    MARKETPLACE_PROGRAM_ID
  )[0];
}
export function metadataPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      MPL_TOKEN_METADATA_ID.toBuffer(),
      mint.toBuffer(),
    ],
    MPL_TOKEN_METADATA_ID
  )[0];
}

// ---------------------------------------------------------------------------
// External account decoders (layouts verified against the on-chain IDLs)
// ---------------------------------------------------------------------------

export interface Market {
  superAdmin: PublicKey;
  marketAdmin: PublicKey;
  treasury: PublicKey;
  royaltyFeeBps: number;
  paused: boolean;
  usdcMint: PublicKey;
}

export function decodeMarket(d: Buffer): Market {
  const o = 8 + 4;
  const afterTreasury = o + 32 * 3 + 1 + 32;
  return {
    superAdmin: new PublicKey(d.subarray(o, o + 32)),
    marketAdmin: new PublicKey(d.subarray(o + 32, o + 64)),
    treasury: new PublicKey(d.subarray(o + 97, o + 129)),
    royaltyFeeBps: d.readUInt16LE(afterTreasury),
    paused: d[afterTreasury + 2 + 8] === 1,
    usdcMint: new PublicKey(
      d.subarray(afterTreasury + 2 + 8 + 3, afterTreasury + 2 + 8 + 3 + 32)
    ),
  };
}

export interface Listing {
  address: PublicKey;
  seller: PublicKey;
  nft: PublicKey;
  collection: PublicKey;
  price: bigint;
  createdAt: number;
  updatedAt: number;
  rentPayer: PublicKey;
}

export const LISTING_DISCRIMINATOR = Buffer.from([
  218, 32, 50, 73, 43, 134, 26, 58,
]);

export function decodeListing(address: PublicKey, d: Buffer): Listing {
  const o = 105; // 8 disc + 3 pubkeys + bump
  return {
    address,
    seller: new PublicKey(d.subarray(8, 40)),
    nft: new PublicKey(d.subarray(40, 72)),
    collection: new PublicKey(d.subarray(72, 104)),
    price: d.readBigUInt64LE(o),
    createdAt: Number(d.readBigInt64LE(o + 9)),
    updatedAt: Number(d.readBigInt64LE(o + 17)),
    rentPayer: new PublicKey(d.subarray(o + 25, o + 57)),
  };
}

export interface SpendingLimit {
  multisig: PublicKey;
  createKey: PublicKey;
  vaultIndex: number;
  mint: PublicKey;
  amount: bigint;
  period: "OneTime" | "Day" | "Week" | "Month";
  remainingAmount: bigint;
  lastReset: number;
  members: PublicKey[];
  destinations: PublicKey[];
}

export function decodeSpendingLimit(d: Buffer): SpendingLimit {
  let o = 8;
  const pk = () => {
    const v = new PublicKey(d.subarray(o, o + 32));
    o += 32;
    return v;
  };
  const u64 = () => {
    const v = d.readBigUInt64LE(o);
    o += 8;
    return v;
  };
  const multisig = pk();
  const createKey = pk();
  const vaultIndex = d[o++];
  const mint = pk();
  const amount = u64();
  const period = (["OneTime", "Day", "Week", "Month"] as const)[d[o++]];
  const remainingAmount = u64();
  const lastReset = Number(d.readBigInt64LE(o));
  o += 8;
  o += 1; // bump
  const vec = () => {
    const n = d.readUInt32LE(o);
    o += 4;
    const out: PublicKey[] = [];
    for (let i = 0; i < n; i++) out.push(pk());
    return out;
  };
  const members = vec();
  const destinations = vec();
  return {
    multisig,
    createKey,
    vaultIndex,
    mint,
    amount,
    period,
    remainingAmount,
    lastReset,
    members,
    destinations,
  };
}

// ---------------------------------------------------------------------------
// Program accounts
// ---------------------------------------------------------------------------

export interface Policy {
  allowedCollection: PublicKey;
  maxPerTx: BN;
  maxPurchasesPerPeriod: number;
  periodSeconds: number;
  minSaleBps: number;
}

export interface CoffreAccount {
  bump: number;
  multisig: PublicKey;
  authority: PublicKey;
  spendingLimit: PublicKey;
  manager: PublicKey;
  allowedCollection: PublicKey;
  marketplace: PublicKey;
  usdcMint: PublicKey;
  maxPerTx: BN;
  maxPurchasesPerPeriod: number;
  purchasesThisPeriod: number;
  periodStartedAt: BN;
  periodSeconds: number;
  minSaleBps: number;
}

export interface CardAccount {
  bump: number;
  coffre: PublicKey;
  mint: PublicKey;
  costBasis: BN;
  acquiredAt: BN;
  listing: PublicKey;
}

export const CARD_DISCRIMINATOR = Buffer.from(
  (IDL_JSON.accounts as any[]).find((a) => a.name === "Card").discriminator
);
export const COFFRE_DISCRIMINATOR = Buffer.from(
  (IDL_JSON.accounts as any[]).find((a) => a.name === "Coffre").discriminator
);

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/** A provider that never signs; instruction building does not need a wallet. */
export function readOnlyProvider(connection: Connection): Provider {
  const kp = Keypair.generate();
  return new AnchorProvider(
    connection,
    {
      publicKey: kp.publicKey,
      signTransaction: async (t: any) => t,
      signAllTransactions: async (t: any) => t,
    } as any,
    {}
  );
}

export interface BuyAccounts {
  /** NFT mint being bought. */
  asset: PublicKey;
  /** The marketplace listing (from `fetchListing`). */
  listing: Listing;
  /** `market.treasury` (from `fetchMarket`). */
  marketTreasury: PublicKey;
  /**
   * Squads multisig + vault USDC account: when given, `buy` tops the coffre up
   * from the spending limit inside the same instruction if the balance is short.
   */
  autoFund?: {
    multisig: PublicKey;
    spendingLimit: PublicKey;
    vault: PublicKey;
  };
}

export class CoffreClient {
  readonly program: Program<CoffreIdl>;

  constructor(
    readonly connection: Connection,
    provider: Provider = readOnlyProvider(connection)
  ) {
    this.program = new Program<CoffreIdl>(IDL, provider);
  }

  get programId(): PublicKey {
    return this.program.programId;
  }

  // ----- reads -----

  async fetchCoffre(coffre: PublicKey): Promise<CoffreAccount | null> {
    return (await this.program.account.coffre.fetchNullable(
      coffre
    )) as CoffreAccount | null;
  }

  async fetchCard(
    coffre: PublicKey,
    mint: PublicKey
  ): Promise<CardAccount | null> {
    return (await this.program.account.card.fetchNullable(
      cardPda(coffre, mint, this.programId)
    )) as CardAccount | null;
  }

  async fetchCards(coffre: PublicKey): Promise<CardAccount[]> {
    const rows = await this.program.account.card.all([
      { memcmp: { offset: 8 + 1, bytes: coffre.toBase58() } },
    ]);
    return rows.map((r) => r.account as CardAccount);
  }

  async fetchMarket(): Promise<Market> {
    const info = await this.connection.getAccountInfo(MARKET_PDA);
    if (!info)
      throw new Error("Collector Crypt market not found on this cluster");
    return decodeMarket(info.data);
  }

  async fetchListing(
    asset: PublicKey,
    seller: PublicKey
  ): Promise<Listing | null> {
    const address = listingPda(asset, seller);
    const info = await this.connection.getAccountInfo(address);
    return info ? decodeListing(address, info.data) : null;
  }

  /** All live listings of `seller` (e.g. the coffre) on the marketplace. */
  async fetchListingsBySeller(seller: PublicKey): Promise<Listing[]> {
    const rows = await this.connection.getProgramAccounts(
      MARKETPLACE_PROGRAM_ID,
      {
        filters: [
          { memcmp: { offset: 0, bytes: bs58(LISTING_DISCRIMINATOR) } },
          { memcmp: { offset: 8, bytes: seller.toBase58() } },
        ],
      }
    );
    return rows.map((r) => decodeListing(r.pubkey, r.account.data));
  }

  /** Listings of one NFT (normally zero or one), whoever the seller is. */
  async fetchListingsByAsset(asset: PublicKey): Promise<Listing[]> {
    const rows = await this.connection.getProgramAccounts(MARKETPLACE_PROGRAM_ID, {
      filters: [
        { memcmp: { offset: 0, bytes: bs58(LISTING_DISCRIMINATOR) } },
        { memcmp: { offset: 40, bytes: asset.toBase58() } },
      ],
    });
    return rows.map((r) => decodeListing(r.pubkey, r.account.data));
  }

  /** Resolves a pasted listing address or NFT mint to a live listing. */
  async resolveListing(input: PublicKey): Promise<Listing | null> {
    const info = await this.connection.getAccountInfo(input);
    if (info && info.owner.equals(MARKETPLACE_PROGRAM_ID) && info.data.subarray(0, 8).equals(LISTING_DISCRIMINATOR)) {
      return decodeListing(input, info.data);
    }
    const byAsset = await this.fetchListingsByAsset(input);
    return byAsset[0] ?? null;
  }

  async fetchSpendingLimit(address: PublicKey): Promise<SpendingLimit | null> {
    const info = await this.connection.getAccountInfo(address);
    return info ? decodeSpendingLimit(info.data) : null;
  }

  // ----- setup -----

  initialize(args: {
    payer: PublicKey;
    multisig: PublicKey;
    usdcMint: PublicKey;
    policy: Policy;
  }) {
    const coffre = coffrePda(args.multisig, this.programId);
    return this.program.methods
      .initialize(args.policy)
      .accountsStrict({
        payer: args.payer,
        multisig: args.multisig,
        coffre,
        market: MARKET_PDA,
        usdcMint: args.usdcMint,
        coffreUsdc: ata(args.usdcMint, coffre),
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  // ----- treasury-only (put these inside a Path-A proposal) -----

  setManager(c: CoffreAccount & { address: PublicKey }, newManager: PublicKey) {
    return this.program.methods
      .setManager(newManager)
      .accountsStrict({ coffre: c.address, authority: c.authority })
      .instruction();
  }

  setPolicy(c: CoffreAccount & { address: PublicKey }, policy: Policy) {
    return this.program.methods
      .setPolicy(policy)
      .accountsStrict({ coffre: c.address, authority: c.authority })
      .instruction();
  }

  setSpendingLimit(
    c: CoffreAccount & { address: PublicKey },
    spendingLimit: PublicKey
  ) {
    return this.program.methods
      .setSpendingLimit()
      .accountsStrict({
        coffre: c.address,
        authority: c.authority,
        spendingLimit,
      })
      .instruction();
  }

  depositCard(
    c: CoffreAccount & { address: PublicKey },
    mint: PublicKey,
    costBasis: BN
  ) {
    return this.program.methods
      .depositCard(costBasis)
      .accountsStrict({
        coffre: c.address,
        authority: c.authority,
        card: cardPda(c.address, mint, this.programId),
        nftMint: mint,
        metadata: metadataPda(mint),
        source: ata(mint, c.authority),
        coffreNft: ata(mint, c.address),
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  withdrawUsdc(c: CoffreAccount & { address: PublicKey }, amount: BN) {
    return this.program.methods
      .withdrawUsdc(amount)
      .accountsStrict({
        coffre: c.address,
        authority: c.authority,
        usdcMint: c.usdcMint,
        coffreUsdc: ata(c.usdcMint, c.address),
        treasuryUsdc: ata(c.usdcMint, c.authority),
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  /** `listing` must be passed when the card is currently listed (see `CardAccount.listing`). */
  withdrawCard(
    c: CoffreAccount & { address: PublicKey },
    mint: PublicKey,
    listing: Listing | null
  ) {
    return this.program.methods
      .withdrawCard()
      .accountsStrict({
        coffre: c.address,
        authority: c.authority,
        card: cardPda(c.address, mint, this.programId),
        nftMint: mint,
        coffreNft: ata(mint, c.address),
        treasuryNft: ata(mint, c.authority),
        marketplace: c.marketplace,
        listing: listing ? listing.address : null,
        listingRentReceiver: listing ? listing.rentPayer : null,
        market: listing ? MARKET_PDA : null,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  // ----- permissionless -----

  fund(c: CoffreAccount & { address: PublicKey }, amount: BN) {
    return this.program.methods
      .fund(amount)
      .accountsStrict({
        coffre: c.address,
        multisig: c.multisig,
        spendingLimit: c.spendingLimit,
        vault: c.authority,
        usdcMint: c.usdcMint,
        vaultUsdc: ata(c.usdcMint, c.authority),
        coffreUsdc: ata(c.usdcMint, c.address),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        squadsProgram: SQUADS_PROGRAM_ID,
      })
      .instruction();
  }

  sweepSale(c: CoffreAccount & { address: PublicKey }, mint: PublicKey) {
    return this.program.methods
      .sweepSale()
      .accountsStrict({
        coffre: c.address,
        authority: c.authority,
        card: cardPda(c.address, mint, this.programId),
        assetId: mint,
        coffreNft: ata(mint, c.address),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
  }

  // ----- manager -----

  buy(
    c: CoffreAccount & { address: PublicKey },
    manager: PublicKey,
    expectedPrice: BN,
    a: BuyAccounts
  ) {
    const seller = a.listing.seller;
    const autoFund = a.autoFund;
    return this.program.methods
      .buy(expectedPrice)
      .accountsStrict({
        coffre: c.address,
        manager,
        card: cardPda(c.address, a.asset, this.programId),
        assetId: a.asset,
        metadata: metadataPda(a.asset),
        coffreNft: ata(a.asset, c.address),
        usdcMint: c.usdcMint,
        coffreUsdc: ata(c.usdcMint, c.address),
        marketplace: c.marketplace,
        seller,
        listingRentReceiver: a.listing.rentPayer,
        market: MARKET_PDA,
        whitelistEntry: whitelistEntryPda(c.allowedCollection),
        listing: a.listing.address,
        sellerNftAccount: ata(a.asset, seller),
        sellerUsdcAccount: ata(c.usdcMint, seller),
        treasury: a.marketTreasury,
        treasuryTokenAccount: ata(c.usdcMint, a.marketTreasury),
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        multisig: autoFund ? autoFund.multisig : null,
        spendingLimit: autoFund ? autoFund.spendingLimit : null,
        vault: autoFund ? autoFund.vault : null,
        vaultUsdc: autoFund ? ata(c.usdcMint, autoFund.vault) : null,
        squadsProgram: autoFund ? SQUADS_PROGRAM_ID : null,
      })
      .instruction();
  }

  list(
    c: CoffreAccount & { address: PublicKey },
    manager: PublicKey,
    mint: PublicKey,
    price: BN
  ) {
    return this.program.methods
      .list(price)
      .accountsStrict({
        coffre: c.address,
        manager,
        card: cardPda(c.address, mint, this.programId),
        assetId: mint,
        coffreNft: ata(mint, c.address),
        metadata: metadataPda(mint),
        marketplace: c.marketplace,
        market: MARKET_PDA,
        whitelistEntry: whitelistEntryPda(c.allowedCollection),
        listing: listingPda(mint, c.address),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  updateListing(
    c: CoffreAccount & { address: PublicKey },
    manager: PublicKey,
    mint: PublicKey,
    newPrice: BN
  ) {
    return this.program.methods
      .updateListing(newPrice)
      .accountsStrict({
        coffre: c.address,
        manager,
        card: cardPda(c.address, mint, this.programId),
        assetId: mint,
        listing: listingPda(mint, c.address),
        marketplace: c.marketplace,
        market: MARKET_PDA,
      })
      .instruction();
  }

  /** `rentReceiver` must be the listing's `rent_payer` (whoever paid to list). */
  cancelListing(
    c: CoffreAccount & { address: PublicKey },
    manager: PublicKey,
    mint: PublicKey,
    rentReceiver: PublicKey
  ) {
    return this.program.methods
      .cancelListing()
      .accountsStrict({
        coffre: c.address,
        manager,
        card: cardPda(c.address, mint, this.programId),
        assetId: mint,
        coffreNft: ata(mint, c.address),
        listing: listingPda(mint, c.address),
        rentReceiver,
        marketplace: c.marketplace,
        market: MARKET_PDA,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }
}

/** Sale floor exactly as the program computes it. */
export function saleFloor(costBasis: BN, minSaleBps: number): BN {
  return costBasis.muln(minSaleBps).divn(10_000);
}

export type Ix = TransactionInstruction;

// Tiny base58 for the getProgramAccounts memcmp filter (avoids a bs58 dependency).
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58(buf: Buffer): string {
  let n = BigInt("0x" + buf.toString("hex"));
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of buf) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}
