export type NetworkId = "proxy" | "mainnet" | "devnet" | "custom";

/**
 * `proxy` hits the Cloudflare Pages Function in functions/api/rpc.ts, which holds
 * the real endpoint in a server-side binding. It is the only option where the RPC
 * URL is genuinely secret — anything reaching the browser is public by definition.
 *
 * VITE_RPC_URL is a local convenience default, not a secret: Vite inlines it into
 * the bundle at build time.
 */
export const PROXY_ENDPOINT = "/api/rpc";

export const NETWORKS: Record<Exclude<NetworkId, "custom">, { label: string; endpoint: string }> = {
  proxy: { label: "Private proxy", endpoint: PROXY_ENDPOINT },
  devnet: { label: "Devnet", endpoint: "https://api.devnet.solana.com" },
  mainnet: { label: "Mainnet-beta", endpoint: "https://api.mainnet-beta.solana.com" },
};

export const ENV_RPC_URL: string = (import.meta as any).env?.VITE_RPC_URL ?? "";

/** With a local .env.local or a deployed proxy, start on the one that works. */
export const DEFAULT_NETWORK: NetworkId = ENV_RPC_URL ? "custom" : "devnet";

export const RPC_HINT =
  "Public RPCs rate-limit hard. Use “Private proxy” on a Cloudflare deployment, or paste your own endpoint.";
