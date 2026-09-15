import { PublicKey, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { useEffect, useState } from "react";
import { coffrePda, MAINNET_USDC } from "./lib/coffre";
import { rawToUi, uiToRaw, type DaoView } from "./lib/futarchy";
import {
  addSpendingLimit,
  listSpendingLimits,
  newCreateKey,
  removeSpendingLimit,
  spendingLimitPda,
  type Period,
  type SpendingLimitRow,
} from "./lib/spendingLimit";

type Props = {
  dao: DaoView;
  connection: Connection;
  busy: boolean;
  onAdd: (ixs: TransactionInstruction[]) => void;
  say: (line: string) => void;
};

const parseKeys = (text: string) =>
  text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => new PublicKey(s));

/**
 * Path-B action: a proposal made only of `MultisigAddSpendingLimit` /
 * `MultisigRemoveSpendingLimit`. Defaults are the Coffre budget of this DAO
 * (members = destinations = the coffre PDA).
 */
export default function SpendingLimitAction({ dao, connection, busy, onAdd, say }: Props) {
  const coffre = coffrePda(dao.multisig);
  const [action, setAction] = useState<"add" | "remove">("add");
  const [createKey, setCreateKey] = useState(() => newCreateKey());
  const [mint, setMint] = useState(MAINNET_USDC.toBase58());
  const [amount, setAmount] = useState("");
  const [period, setPeriod] = useState<Period>("Month");
  const [members, setMembers] = useState(coffre.toBase58());
  const [destinations, setDestinations] = useState(coffre.toBase58());
  const [memo, setMemo] = useState("coffre budget");
  const [limits, setLimits] = useState<SpendingLimitRow[] | null>(null);
  const [toRemove, setToRemove] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLimits(null);
    setToRemove("");
  }, [dao.multisig.toBase58()]);

  const loadLimits = async () => {
    try {
      const rows = await listSpendingLimits(connection, dao.multisig);
      setLimits(rows);
      if (rows.length && !toRemove) setToRemove(rows[0].address.toBase58());
      say(`📋 ${rows.length} spending limit(s) on this multisig.`);
    } catch (e: any) {
      setError(e.message ?? String(e));
    }
  };

  const add = () => {
    setError(null);
    try {
      if (action === "add") {
        const mintKey = new PublicKey(mint.trim());
        const decimals = mintKey.equals(dao.quoteMint) ? dao.quoteDecimals : 6;
        const raw = uiToRaw(amount, decimals);
        if (raw.isZero()) throw new Error("Amount must be greater than zero.");
        const m = parseKeys(members);
        const d = parseKeys(destinations);
        if (m.length === 0) throw new Error("At least one member is required.");
        const ix = addSpendingLimit(dao, {
          createKey,
          mint: mintKey,
          amount: BigInt(raw.toString()),
          period,
          members: m,
          destinations: d,
          memo: memo.trim() || undefined,
        });
        const pda = spendingLimitPda(dao.multisig, createKey);
        onAdd([ix]);
        say(`ℹ️ Spending limit PDA will be ${pda.toBase58()} (create key ${createKey.toBase58()}). Record both.`);
        say("ℹ️ After this passes, a separate Path-A proposal must call Coffre · set_spending_limit with that PDA.");
        setCreateKey(newCreateKey());
      } else {
        if (!toRemove) throw new Error("Pick a spending limit to remove.");
        onAdd([removeSpendingLimit(dao, new PublicKey(toRemove))]);
      }
    } catch (e: any) {
      setError(e.message ?? String(e));
    }
  };

  const isCoffreDefault = members.trim() === coffre.toBase58() && destinations.trim() === coffre.toBase58();

  return (
    <div className="form">
      <p className="hint">
        Executes on <b>Path B</b>: the futarchy program signs as the DAO (config authority) and
        refuses any other instruction in the same proposal. Setup takes two proposals — this one,
        then a normal one with <span className="mono">set_spending_limit</span>.
      </p>
      <div className="tabs">
        <button className={action === "add" ? "tab on" : "tab"} onClick={() => setAction("add")}>
          Add limit
        </button>
        <button className={action === "remove" ? "tab on" : "tab"} onClick={() => setAction("remove")}>
          Remove limit
        </button>
      </div>

      {action === "add" ? (
        <>
          <label className="field">
            <span>Mint</span>
            <input value={mint} onChange={(e) => setMint(e.target.value)} />
          </label>
          <label className="field">
            <span>Amount per period (tokens)</span>
            <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 2000" />
          </label>
          <label className="field">
            <span>Period</span>
            <select value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
              <option value="Month">Month (30 days)</option>
              <option value="Week">Week</option>
              <option value="Day">Day</option>
              <option value="OneTime">One time</option>
            </select>
          </label>
          <label className="field">
            <span>Members (who may spend it)</span>
            <textarea rows={2} value={members} onChange={(e) => setMembers(e.target.value)} />
          </label>
          <label className="field">
            <span>Destinations (empty = anywhere)</span>
            <textarea rows={2} value={destinations} onChange={(e) => setDestinations(e.target.value)} />
          </label>
          <label className="field">
            <span>Memo</span>
            <input value={memo} onChange={(e) => setMemo(e.target.value)} />
          </label>
          <p className="hint">
            {isCoffreDefault
              ? `Locked to the coffre ${coffre.toBase58().slice(0, 8)}…: only the coffre can draw it and only into itself.`
              : "⚠️ Not the coffre defaults — a wallet listed here can spend directly from the treasury."}
            {" "}Create key: <span className="mono">{createKey.toBase58()}</span>
          </p>
        </>
      ) : (
        <>
          <div className="row wrap">
            <button onClick={loadLimits} disabled={busy}>
              Load this DAO's limits
            </button>
          </div>
          {limits && limits.length === 0 && <div className="empty">No spending limit on this multisig.</div>}
          {limits && limits.length > 0 && (
            <label className="field">
              <span>Spending limit to remove</span>
              <select value={toRemove} onChange={(e) => setToRemove(e.target.value)}>
                {limits.map((l) => (
                  <option key={l.address.toBase58()} value={l.address.toBase58()}>
                    {l.address.toBase58().slice(0, 8)}… · {rawToUi(new (require("bn.js"))(l.amount.toString()), 6)} /{" "}
                    {l.period} · members {l.members.length} · destinations {l.destinations.length || "any"}
                  </option>
                ))}
              </select>
            </label>
          )}
        </>
      )}

      {error && <div className="banner">{error}</div>}
      <div className="actions">
        <button className="primary" onClick={add} disabled={busy}>
          Add to proposal
        </button>
      </div>
    </div>
  );
}
