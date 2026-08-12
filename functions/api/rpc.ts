/**
 * Server-side RPC proxy — the only way an endpoint URL stays secret in a static SPA.
 *
 * The browser calls /api/rpc; this function forwards to the real endpoint held in
 * the RPC_URL binding. The key never reaches the client bundle.
 *
 *   npx wrangler pages secret put RPC_URL
 *
 * Locally: put RPC_URL in .dev.vars and run `npx wrangler pages dev dist`.
 */

/** Methods the app actually needs. Keeps a public deployment from becoming an open relay. */
const ALLOWED = new Set([
  "getAccountInfo",
  "getMultipleAccounts",
  "getProgramAccounts",
  "getBalance",
  "getTokenAccountsByOwner",
  "getTokenAccountBalance",
  "getTokenSupply",
  "getLatestBlockhash",
  "getSignatureStatuses",
  "getSignaturesForAddress",
  "getTransaction",
  "getSlot",
  "getEpochInfo",
  "getMinimumBalanceForRentExemption",
  "getFeeForMessage",
  "simulateTransaction",
  "sendTransaction",
  "isBlockhashValid",
  "getVersion",
]);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export const onRequestPost = async (ctx: any): Promise<Response> => {
  const upstream: string | undefined = ctx.env?.RPC_URL;
  if (!upstream) {
    return json({ error: "RPC_URL is not configured on this deployment." }, 500);
  }

  // Same-origin only: a public proxy would otherwise burn someone else's quota.
  const origin = ctx.request.headers.get("origin");
  if (origin && new URL(origin).host !== new URL(ctx.request.url).host) {
    return json({ error: "Cross-origin requests are not allowed." }, 403);
  }

  let payload: any;
  try {
    payload = await ctx.request.json();
  } catch {
    return json({ error: "Body must be JSON-RPC." }, 400);
  }

  const calls = Array.isArray(payload) ? payload : [payload];
  const blocked = calls.find((c) => !ALLOWED.has(c?.method));
  if (blocked) {
    return json({ error: `Method not allowed: ${blocked?.method}` }, 403);
  }

  const res = await fetch(upstream, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  return new Response(res.body, {
    status: res.status,
    headers: { "content-type": "application/json" },
  });
};
