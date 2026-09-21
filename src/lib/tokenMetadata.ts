/**
 * Read and update a DAO token's Metaplex metadata by proposal.
 *
 * On a MetaDAO / Futardio launch the metadata's update authority is the DAO treasury
 * (the Squads vault), so nobody — not the team, not the launcher — can rename the token
 * or repoint its image except a passed proposal making the vault sign
 * `UpdateMetadataAccountV2`.
 *
 * Only `name`, `symbol` and `uri` live on-chain. Description and image live in the JSON
 * the `uri` points to, so changing them means hosting a new JSON first and pointing the
 * `uri` at it.
 *
 * The instruction is encoded by hand (no mpl-token-metadata dependency); the layout was
 * validated by simulating it against the live Metaplex program.
 */
import type { Connection } from "@solana/web3.js";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import type { DaoView } from "./futarchy";

export const MPL_TOKEN_METADATA = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
/** Metaplex instruction index of UpdateMetadataAccountV2. */
const UPDATE_METADATA_ACCOUNT_V2 = 15;
/** Metaplex caps, enforced on-chain: longer values are rejected. */
export const MAX_NAME = 32;
export const MAX_SYMBOL = 10;
export const MAX_URI = 200;

export type Creator = { address: PublicKey; verified: boolean; share: number };

export type TokenMetadata = {
  metadata: PublicKey;
  updateAuthority: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  sellerFeeBasisPoints: number;
  creators: Creator[] | null;
  isMutable: boolean;
  collection: { verified: boolean; key: PublicKey } | null;
  hasUses: boolean;
};

export function metadataPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), MPL_TOKEN_METADATA.toBuffer(), mint.toBuffer()],
    MPL_TOKEN_METADATA,
  )[0];
}

export async function readTokenMetadata(connection: Connection, mint: PublicKey): Promise<TokenMetadata> {
  const metadata = metadataPda(mint);
  const info = await connection.getAccountInfo(metadata);
  if (!info) throw new Error("This mint has no Metaplex metadata account.");
  const b = info.data as Buffer;
  let o = 1; // key
  const updateAuthority = new PublicKey(b.subarray(o, o + 32));
  o += 32 + 32; // update authority + mint
  const str = () => {
    const len = b.readUInt32LE(o);
    o += 4;
    const s = b.subarray(o, o + len).toString("utf8").replace(/\0+$/, "").trim();
    o += len;
    return s;
  };
  const name = str(), symbol = str(), uri = str();
  const sellerFeeBasisPoints = b.readUInt16LE(o);
  o += 2;
  let creators: Creator[] | null = null;
  if (b[o++] === 1) {
    const n = b.readUInt32LE(o);
    o += 4;
    creators = [];
    for (let i = 0; i < n; i++) {
      creators.push({ address: new PublicKey(b.subarray(o, o + 32)), verified: b[o + 32] === 1, share: b[o + 33] });
      o += 34;
    }
  }
  o += 1; // primary_sale_happened
  const isMutable = b[o++] === 1;
  if (b[o++] === 1) o += 1; // edition_nonce
  if (b[o++] === 1) o += 1; // token_standard
  let collection: TokenMetadata["collection"] = null;
  if (b[o++] === 1) {
    collection = { verified: b[o] === 1, key: new PublicKey(b.subarray(o + 1, o + 33)) };
    o += 33;
  }
  const hasUses = b[o] === 1;
  return { metadata, updateAuthority, name, symbol, uri, sellerFeeBasisPoints, creators, isMutable, collection, hasUses };
}

const borshString = (s: string) => {
  const bytes = Buffer.from(s, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length);
  return Buffer.concat([len, bytes]);
};

/**
 * `UpdateMetadataAccountV2` changing name / symbol / uri and nothing else. Creators,
 * collection and the seller fee are carried over unchanged; the update authority,
 * primary-sale flag and mutability are left alone (all three `None`).
 */
export function updateTokenMetadata(
  dao: DaoView,
  current: TokenMetadata,
  next: { name: string; symbol: string; uri: string },
): TransactionInstruction[] {
  if (!current.updateAuthority.equals(dao.treasury)) {
    throw new Error(
      `The update authority is ${current.updateAuthority.toBase58().slice(0, 8)}…, not this DAO's treasury — a proposal cannot sign this.`,
    );
  }
  if (!current.isMutable) throw new Error("This metadata is immutable. Nothing can change it.");
  if (current.hasUses) throw new Error("This metadata carries a `uses` field; refusing to rewrite it blind.");
  const over = (label: string, v: string, max: number) => {
    const n = Buffer.byteLength(v, "utf8");
    if (n === 0) throw new Error(`${label} is empty.`);
    if (n > max) throw new Error(`${label} is ${n} bytes; Metaplex allows ${max}.`);
  };
  over("Name", next.name, MAX_NAME);
  over("Symbol", next.symbol, MAX_SYMBOL);
  over("URI", next.uri, MAX_URI);

  const fee = Buffer.alloc(2);
  fee.writeUInt16LE(current.sellerFeeBasisPoints);
  const creators = current.creators
    ? Buffer.concat([
        Buffer.from([1]),
        (() => { const n = Buffer.alloc(4); n.writeUInt32LE(current.creators!.length); return n; })(),
        ...current.creators.map((c) => Buffer.concat([c.address.toBuffer(), Buffer.from([c.verified ? 1 : 0, c.share])])),
      ])
    : Buffer.from([0]);
  const collection = current.collection
    ? Buffer.concat([Buffer.from([1, current.collection.verified ? 1 : 0]), current.collection.key.toBuffer()])
    : Buffer.from([0]);

  const data = Buffer.concat([
    Buffer.from([UPDATE_METADATA_ACCOUNT_V2]),
    Buffer.from([1]), // Some(DataV2)
    borshString(next.name),
    borshString(next.symbol),
    borshString(next.uri),
    fee,
    creators,
    collection,
    Buffer.from([0]), // uses: None
    Buffer.from([0]), // new update authority: None
    Buffer.from([0]), // primary_sale_happened: None
    Buffer.from([0]), // is_mutable: None
  ]);

  return [
    new TransactionInstruction({
      programId: MPL_TOKEN_METADATA,
      keys: [
        { pubkey: current.metadata, isWritable: true, isSigner: false },
        { pubkey: dao.treasury, isWritable: false, isSigner: true },
      ],
      data,
    }),
  ];
}

export function describeTokenMetadataIx(ix: TransactionInstruction): string | null {
  if (!ix.programId.equals(MPL_TOKEN_METADATA)) return null;
  if (ix.data[0] !== UPDATE_METADATA_ACCOUNT_V2 || ix.data[1] !== 1) return "Metaplex · metadata instruction";
  try {
    let o = 2;
    const str = () => { const l = ix.data.readUInt32LE(o); o += 4; const s = ix.data.subarray(o, o + l).toString("utf8"); o += l; return s; };
    const name = str(), symbol = str();
    return `Token metadata → ${name} (${symbol})`;
  } catch {
    return "Metaplex · update metadata";
  }
}
