import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { useCallback, useEffect, useState } from "react";
import { PERIOD_LABEL, findAllowances, withdrawAllowanceTx, type Allowance } from "./lib/allowance";
import type { SendFn } from "./lib/flow";
import { rawToUi, uiToRaw, type DaoView } from "./lib/futarchy";

type Props = {
  dao: DaoView;
  connection: Connection;
  wallet: { publicKey: PublicKey } | null;
  busy: boolean;
  send: SendFn;
  say: (line: string) => void;
  run: (label: string, fn: () => Promise<void>) => Promise<void> | void;
};

const ui = (v: bigint, d: number) => rawToUi(new BN(v.toString()), d);
const short = (k: PublicKey) => `${k.toBase58().slice(0, 4)}…${k.toBase58().slice(-4)}`;

/**
 * The monthly allowance, withdrawn by a member's own signature. No proposal: the
 * spending limit itself is the authorization the market already voted for.
 */
export default function AllowancePanel({ dao, connection, wallet, busy, send, say, run }: Props) {
  const [list, setList] = useState<Allowance[] | null>(null);
  const [treasuryHeld, setTreasuryHeld] = useState<Record<string, bigint>>({});
  const [sel, setSel] = useState(0);
  const [amount, setAmount] = useState("");
  const [destination, setDestination] = useState("");

  const load = useCallback(async () => {
    const found = await findAllowances(connection, dao);
    setList(found);
    setSel(0);
    const held: Record<string, bigint> = {};
    for (const a of found) {
      const key = a.address.toBase58();
      if (!a.mint) {
        held[key] = BigInt(await connection.getBalance(dao.treasury));
        continue;
      }
      const info = await connection.getAccountInfo(getAssociatedTokenAddressSync(a.mint, dao.treasury, true, a.tokenProgram));
      held[key] = info ? (info.data as Buffer).readBigUInt64LE(64) : 0n;
    }
    setTreasuryHeld(held);
    if (found[0]) setAmount(ui(found[0].available, found[0].decimals));
  }, [connection, dao]);

  useEffect(() => {
    load().catch((e) => say(`❌ reading allowances — ${e?.message ?? e}`));
  }, [load, say]);

  useEffect(() => {
    if (wallet && !destination) setDestination(wallet.publicKey.toBase58());
  }, [wallet, destination]);

  const a = list?.[sel];
  const isMember = !!(a && wallet && a.members.some((m) => m.equals(wallet.publicKey)));
  const held = a ? treasuryHeld[a.address.toBase58()] : undefined;

  return (
    <div className="panel">
      <h2>Monthly allowance</h2>
      <p className="sub">
        The treasury's spending limit. A listed wallet withdraws from it with its own signature — no proposal, no vote —
        up to what is left this period.
      </p>

      {list === null && <div className="empty">Reading the spending limits…</div>}
      {list && list.length === 0 && <div className="empty">This DAO has no spending limit.</div>}

      {list && list.length > 1 && (
        <div className="row wrap">
          {list.map((x, i) => (
            <button key={x.address.toBase58()} className={i === sel ? "tab on" : "tab"} onClick={() => { setSel(i); setAmount(ui(x.available, x.decimals)); }}>
              {ui(x.amount, x.decimals)} {x.symbol} / {PERIOD_LABEL[x.period]}
            </button>
          ))}
        </div>
      )}

      {a && (
        <>
          <div className="stats">
            <div className="stat"><div className="k">Allowance</div><div className="v">{ui(a.amount, a.decimals)}<small> {a.symbol} / {PERIOD_LABEL[a.period]}</small></div></div>
            <div className="stat"><div className="k">Left now</div><div className="v">{ui(a.available, a.decimals)}<small> {a.symbol}</small></div></div>
            <div className="stat"><div className="k">Next reset</div><div className="v">{a.nextReset ? a.nextReset.toISOString().slice(0, 10) : "never"}</div></div>
            <div className="stat"><div className="k">Treasury holds</div><div className="v">{held === undefined ? "—" : ui(held, a.decimals)}<small> {a.symbol}</small></div></div>
          </div>
          <p className="hint">
            Members: {a.members.map((m) => (wallet && m.equals(wallet.publicKey) ? `${short(m)} (you)` : short(m))).join(", ")}.{" "}
            Destinations: {a.destinations.length ? a.destinations.map(short).join(", ") : "any wallet"}. Account {short(a.address)}.
          </p>

          {!wallet && <p className="hint">Connect a member wallet to withdraw.</p>}
          {wallet && !isMember && (
            <p className="hint">⛔ The connected wallet ({short(wallet.publicKey)}) is not a member of this allowance; only a member can sign.</p>
          )}
          {isMember && (
            <>
              <div className="row wrap">
                <label className="field grow">
                  <span>Amount ({a.symbol})</span>
                  <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
                </label>
                <label className="field grow">
                  <span>Send to</span>
                  {a.destinations.length ? (
                    <select value={destination} onChange={(e) => setDestination(e.target.value)}>
                      <option value="">pick a listed destination</option>
                      {a.destinations.map((d) => <option key={d.toBase58()} value={d.toBase58()}>{d.toBase58()}</option>)}
                    </select>
                  ) : (
                    <input value={destination} onChange={(e) => setDestination(e.target.value)} />
                  )}
                </label>
              </div>
              <div className="actions">
                <button
                  className="primary"
                  disabled={busy || !amount.trim() || !destination.trim()}
                  onClick={() =>
                    run("withdrawing the allowance", async () => {
                      if (!wallet) throw new Error("Connect a wallet.");
                      const raw = BigInt(uiToRaw(amount, a.decimals).toString());
                      if (held !== undefined && raw > held) throw new Error(`The treasury holds only ${ui(held, a.decimals)} ${a.symbol}.`);
                      const tx = withdrawAllowanceTx(dao, a, wallet.publicKey, new PublicKey(destination.trim()), raw);
                      const sig = await send(tx, connection, {});
                      say(`✅ Withdrew ${amount} ${a.symbol} to ${short(new PublicKey(destination.trim()))} — ${sig}`);
                      await load();
                    })
                  }
                >
                  Withdraw
                </button>
                <button className="ghost" disabled={busy} onClick={() => run("refreshing", load)}>Refresh</button>
              </div>
              <p className="hint">
                One transaction signed by your wallet: it creates the destination's token account if needed (you pay
                ~0.002 SOL of rent), then pulls the amount from the treasury. A period is 30 days, counted from the
                last reset, not the calendar month.
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}
