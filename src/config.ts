export type NetworkId = "mainnet" | "devnet" | "custom";

export const NETWORKS: Record<Exclude<NetworkId, "custom">, { label: string; endpoint: string }> = {
  devnet: { label: "Devnet", endpoint: "https://api.devnet.solana.com" },
  mainnet: { label: "Mainnet-beta", endpoint: "https://api.mainnet-beta.solana.com" },
};

/**
 * Devnet runs futarchy v0.6.0, mainnet runs v0.6.1. The initializeDao interface
 * differs between them, but the proposal instructions this app uses are identical.
 */
export const DEFAULT_NETWORK: NetworkId = "devnet";

/** Public RPCs rate-limit hard. Point this at Helius/Triton for real use. */
export const RPC_HINT = "Public RPCs rate-limit hard — point 'custom' at your Helius/Triton endpoint.";
