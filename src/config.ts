/**
 * One endpoint, always. The browser talks to /api/rpc and never sees the real URL:
 *
 *   dev         → vite.config.ts proxies it, reading RPC_URL from .env.local
 *   Cloudflare  → functions/api/rpc.ts proxies it, reading the RPC_URL secret
 *
 * A `VITE_`-prefixed variable would be inlined into the bundle and therefore public,
 * which is why RPC_URL deliberately has no prefix.
 */
/** web3.js rejects relative paths, so resolve against the current origin. */
export const RPC_ENDPOINT =
  typeof window === "undefined"
    ? "http://localhost:5173/api/rpc"
    : new URL("/api/rpc", window.location.origin).toString();

/** Genesis hashes, so the app reports the cluster instead of asking the user. */
export const GENESIS = {
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d": "mainnet-beta",
  EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG: "devnet",
  "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY": "testnet",
} as const;

export const RPC_HINT =
  "The endpoint is held server-side. Set RPC_URL in .env.local for dev, or as a Cloudflare secret when deployed.";
