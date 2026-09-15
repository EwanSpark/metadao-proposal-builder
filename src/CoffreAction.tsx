import { ComputeBudgetProgram, PublicKey, Transaction, type Connection, type TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CoffreClient,
  COLLECTOR_CRYPT_STANDARD_NFT_COLLECTION,
  coffrePda,
  ata,
  type CoffreAccount,
  type Policy,
} from "./lib/coffre";
import type { SendFn } from "./lib/flow";
import { rawToUi, uiToRaw, type DaoView } from "./lib/futarchy";
import { listSpendingLimits, type SpendingLimitRow } from "./lib/spendingLimit";

type Props = {
  dao: DaoView;
  connection: Connection;
  wallet: { publicKey: PublicKey } | null;
  busy: boolean;
  onAdd: (ixs: TransactionInstruction[]) => void;
  say: (line: string) => void;
  send: SendFn;
  run: (label: string, fn: () => Promise<void>) => void;
};

type Sub = "set_manager" | "set_policy" | "set_spending_limit" | "deposit_card" | "withdraw_usdc" | "withdraw_card";

const DAY = 86_400;

export function policyForm(initial?: CoffreAccount) {
  return {
    collection: (initial?.allowedCollection ?? COLLECTOR_CRYPT_STANDARD_NFT_COLLECTION).toBase58(),
    maxPerTx: initial ? rawToUi(initial.maxPerTx, 6) : "",
    maxPurchases: String(initial?.maxPurchasesPerPeriod ?? 0),
    periodSeconds: String(initial?.periodSeconds ?? 30 * DAY),
    minSaleBps: String(initial?.minSaleBps ?? 8000),
  };
}

export function toPolicy(f: ReturnType<typeof policyForm>): Policy {
  const maxPurchases = Number(f.maxPurchases);
  const periodSeconds = Number(f.periodSeconds);
  const minSaleBps = Number(f.minSaleBps);
  if (!Number.isInteger(maxPurchases) || maxPurchases < 0) throw new Error("Purchases per period must be a whole number.");
  if (!Number.isInteger(periodSeconds) || periodSeconds < 0) throw new Error("Period must be whole seconds.");
  if (!Number.isInteger(minSaleBps) || minSaleBps < 0 || minSaleBps > 65535) throw new Error("Sale floor must be 0–65535 bps.");
  return {
    allowedCollection: new PublicKey(f.collection.trim()),
    maxPerTx: uiToRaw(f.maxPerTx, 6),
    maxPurchasesPerPeriod: maxPurchases,
    periodSeconds,
    minSaleBps,
  };
}

export function PolicyFields({ value, onChange }: { value: ReturnType<typeof policyForm>; onChange: (v: ReturnType<typeof policyForm>) => void }) {
  const set = (k: keyof typeof value) => (e: React.ChangeEvent<HTMLInputElement>) => onChange({ ...value, [k]: e.target.value });
  return (
    <>
      <label className="field">
        <span>Allowed collection (Metaplex collection mint)</span>
        <input value={value.collection} onChange={set("collection")} />
      </label>
      <label className="field">
        <span>Max per purchase (USDC)</span>
        <input value={value.maxPerTx} onChange={set("maxPerTx")} placeholder="e.g. 500" />
      </label>
      <label className="field">
        <span>Max purchases per period (0 = unlimited)</span>
        <input value={value.maxPurchases} onChange={set("maxPurchases")} />
      </label>
      <label className="field">
        <span>Period (seconds)</span>
        <input value={value.periodSeconds} onChange={set("periodSeconds")} />
      </label>
      <label className="field">
        <span>Sale floor (bps of cost basis, 8000 = 80 %)</span>
        <input value={value.minSaleBps} onChange={set("minSaleBps")} />
      </label>
    </>
  );
}

/**
 * Coffre actions. `initialize` is a direct transaction from the connected wallet
 * (permissionless, nothing trusted comes from it). Everything else is
 * treasury-only and goes into a normal (Path A) proposal.
 */
export default function CoffreAction({ dao, connection, wallet, busy, onAdd, say, send, run }: Props) {
  // Memoized: a fresh PublicKey object per render would retrigger the load effect forever.
  const multisigKey = dao.multisig.toBase58();
  const coffre = useMemo(() => coffrePda(new PublicKey(multisigKey)), [multisigKey]);
  const [client] = useState(() => new CoffreClient(connection));
  const [state, setState] = useState<CoffreAccount | null | undefined>(undefined);
  const [sub, setSub] = useState<Sub>("set_manager");
  const [manager, setManager] = useState("");
  const [policy, setPolicy] = useState(policyForm());
  const [limits, setLimits] = useState<SpendingLimitRow[] | null>(null);
  const [limit, setLimit] = useState("");
  const [mint, setMint] = useState("");
  const [costBasis, setCostBasis] = useState("");
  const [usdcAmount, setUsdcAmount] = useState("");
  const [usdcBalance, setUsdcBalance] = useState<BN | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const c = await client.fetchCoffre(coffre);
    setState(c);
    if (c) {
      setPolicy(policyForm(c));
      try {
        const bal = await connection.getTokenAccountBalance(ata(c.usdcMint, coffre));
        setUsdcBalance(new BN(bal.value.amount));
      } catch {
        setUsdcBalance(new BN(0));
      }
    }
  }, [client, coffre, connection]);

  useEffect(() => {
    setState(undefined);
    reload().catch((e) => setError(e.message ?? String(e)));
  }, [reload]);

  const view = state ? { ...state, address: coffre } : null;

  const initialize = () =>
    run("initialize coffre", async () => {
      if (!wallet) throw new Error("Connect a wallet.");
      const market = await client.fetchMarket();
      const ix = await client.initialize({ payer: wallet.publicKey, multisig: dao.multisig, usdcMint: market.usdcMint, policy: toPolicy(policy) });
      const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 })).add(ix);
      tx.feePayer = wallet.publicKey;
      const sig = await send(tx, connection, {});
      say(`🏦 Coffre initialized at ${coffre.toBase58()} — ${sig}`);
      say("ℹ️ Now propose set_policy + set_manager (Path A) and the spending limit (Path B).");
      await reload();
    });

  const loadLimits = () =>
    run("spending limits", async () => {
      const rows = await listSpendingLimits(connection, dao.multisig);
      setLimits(rows);
      const good = rows.find((r) => fitsCoffre(r));
      setLimit((good ?? rows[0])?.address.toBase58() ?? "");
      say(`📋 ${rows.length} spending limit(s), ${rows.filter(fitsCoffre).length} usable by the coffre.`);
    });

  const fitsCoffre = (r: SpendingLimitRow) =>
    r.vaultIndex === 0 &&
    !!view &&
    r.mint.equals(view.usdcMint) &&
    r.members.some((m) => m.equals(coffre)) &&
    r.destinations.length === 1 &&
    r.destinations[0].equals(coffre);

  const add = () =>
    run("coffre action", async () => {
      setError(null);
      if (!view) throw new Error("The coffre is not initialized.");
      let ixs: TransactionInstruction[] = [];
      if (sub === "set_manager") {
        const key = manager.trim() ? new PublicKey(manager.trim()) : PublicKey.default;
        ixs = [await client.setManager(view, key)];
        say(key.equals(PublicKey.default) ? "ℹ️ Removes the manager: trading stops until a new one is named." : `ℹ️ Manager → ${key.toBase58()}`);
      } else if (sub === "set_policy") {
        ixs = [await client.setPolicy(view, toPolicy(policy))];
      } else if (sub === "set_spending_limit") {
        if (!limit) throw new Error("Pick a spending limit.");
        const row = limits?.find((r) => r.address.toBase58() === limit);
        if (row && !fitsCoffre(row)) throw new Error("That limit does not point at the coffre; the program will refuse it.");
        ixs = [await client.setSpendingLimit(view, new PublicKey(limit))];
      } else if (sub === "deposit_card") {
        ixs = [await client.depositCard(view, new PublicKey(mint.trim()), uiToRaw(costBasis, 6))];
        say("ℹ️ The treasury must hold this NFT in its associated token account at execution time.");
      } else if (sub === "withdraw_usdc") {
        ixs = [await client.withdrawUsdc(view, uiToRaw(usdcAmount, 6))];
      } else if (sub === "withdraw_card") {
        const m = new PublicKey(mint.trim());
        const card = await client.fetchCard(coffre, m);
        if (!card) throw new Error("The coffre holds no Card for this mint.");
        const listing = card.listing.equals(PublicKey.default) ? null : await client.fetchListing(m, coffre);
        ixs = [await client.withdrawCard(view, m, listing)];
        if (listing) say("ℹ️ The card is listed; the withdrawal cancels the listing first.");
      }
      onAdd(ixs);
    });

  if (state === undefined)
    return (
      <div className="form">
        {error ? <div className="banner">Could not read the coffre: {error}</div> : <div className="empty">Loading the coffre…</div>}
      </div>
    );

  if (state === null) {
    return (
      <div className="form">
        <p className="hint">
          No coffre for this DAO yet (<span className="mono">{coffre.toBase58()}</span>). Initializing is
          permissionless and not a proposal: the authority is derived from the multisig, the marketplace is
          fixed, and every policy value below is confirmed later by <span className="mono">set_policy</span>.
        </p>
        <PolicyFields value={policy} onChange={setPolicy} />
        {error && <div className="banner">{error}</div>}
        <div className="actions">
          <button className="primary" onClick={initialize} disabled={busy || !wallet}>
            Initialize coffre (direct transaction)
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="form">
      <div className="stats">
        <div className="stat"><span>Coffre</span><b className="mono trunc">{coffre.toBase58()}</b></div>
        <div className="stat"><span>Manager</span><b className="mono trunc">{state.manager.equals(PublicKey.default) ? "none" : state.manager.toBase58()}</b></div>
        <div className="stat"><span>USDC held</span><b>{usdcBalance ? rawToUi(usdcBalance, 6) : "…"}</b></div>
        <div className="stat"><span>Spending limit</span><b className="mono trunc">{state.spendingLimit.equals(PublicKey.default) ? "not set" : state.spendingLimit.toBase58()}</b></div>
        <div className="stat"><span>Max / purchase</span><b>{rawToUi(state.maxPerTx, 6)} USDC</b></div>
        <div className="stat"><span>Sale floor</span><b>{state.minSaleBps / 100} % of cost</b></div>
      </div>

      <label className="field">
        <span>Instruction</span>
        <select value={sub} onChange={(e) => setSub(e.target.value as Sub)}>
          <option value="set_manager">set_manager — name or remove the manager</option>
          <option value="set_policy">set_policy — caps, floor, collection</option>
          <option value="set_spending_limit">set_spending_limit — point at a Squads limit</option>
          <option value="deposit_card">deposit_card — move a treasury NFT into the coffre</option>
          <option value="withdraw_usdc">withdraw_usdc — coffre → treasury</option>
          <option value="withdraw_card">withdraw_card — coffre → treasury (cancels a listing)</option>
        </select>
      </label>

      {sub === "set_manager" && (
        <label className="field">
          <span>New manager (empty = nobody)</span>
          <input value={manager} onChange={(e) => setManager(e.target.value)} />
        </label>
      )}
      {sub === "set_policy" && <PolicyFields value={policy} onChange={setPolicy} />}
      {sub === "set_spending_limit" && (
        <>
          <div className="row wrap">
            <button onClick={loadLimits} disabled={busy}>Load this DAO's limits</button>
          </div>
          {limits && limits.length === 0 && <div className="empty">No spending limit yet — propose one under “Spending limit”.</div>}
          {limits && limits.length > 0 && (
            <label className="field">
              <span>Spending limit</span>
              <select value={limit} onChange={(e) => setLimit(e.target.value)}>
                {limits.map((l) => (
                  <option key={l.address.toBase58()} value={l.address.toBase58()}>
                    {fitsCoffre(l) ? "✓" : "✗"} {l.address.toBase58().slice(0, 8)}… · {rawToUi(new BN(l.amount.toString()), 6)} / {l.period}
                    {" "}· remaining {rawToUi(new BN(l.remainingAmount.toString()), 6)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </>
      )}
      {(sub === "deposit_card" || sub === "withdraw_card") && (
        <label className="field">
          <span>NFT mint</span>
          <input value={mint} onChange={(e) => setMint(e.target.value)} />
        </label>
      )}
      {sub === "deposit_card" && (
        <label className="field">
          <span>Declared cost basis (USDC) — sets the sale floor</span>
          <input value={costBasis} onChange={(e) => setCostBasis(e.target.value)} />
        </label>
      )}
      {sub === "withdraw_usdc" && (
        <label className="field">
          <span>Amount (USDC)</span>
          <div className="row">
            <input value={usdcAmount} onChange={(e) => setUsdcAmount(e.target.value)} />
            <button className="ghost tiny" onClick={() => usdcBalance && setUsdcAmount(rawToUi(usdcBalance, 6))} disabled={!usdcBalance}>
              all
            </button>
          </div>
        </label>
      )}

      {error && <div className="banner">{error}</div>}
      <div className="actions">
        <button className="primary" onClick={add} disabled={busy}>Add to proposal</button>
        <button className="ghost" onClick={() => run("refresh coffre", reload)} disabled={busy}>Refresh</button>
      </div>
    </div>
  );
}
