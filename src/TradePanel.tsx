import { AccountLayout, getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FutarchyClient } from "@metadaoproject/programs/futarchy";
import type { ProposalRow } from "./lib/discover";
import { redeemConditional, tradeConditional, type SendFn } from "./lib/flow";
import { rawToUi, uiToRaw, type DaoView } from "./lib/futarchy";

type Props = {
  dao: DaoView;
  client: FutarchyClient;
  connection: Connection;
  wallet: { publicKey: PublicKey } | null;
  proposal: ProposalRow;
  busy: boolean;
  send: SendFn;
  say: (line: string) => void;
  run: (label: string, fn: () => Promise<void>) => Promise<void>;
  onDone: () => void;
};

type Pool = { base: BN; quote: BN };

/** Reads a token balance from raw bytes — getTokenAccountBalance is gated on some public RPCs. */
async function rawBalance(connection: Connection, ata: PublicKey): Promise<BN> {
  const info = await connection.getAccountInfo(ata);
  if (!info) return new BN(0);
  return new BN(AccountLayout.decode((info.data as Buffer).subarray(0, AccountLayout.span)).amount.toString());
}

/**
 * The decision market of a live proposal, tradeable from plain tokens. MetaDAO's own
 * sites only list proposals created through them, so a proposal made here has no trading
 * interface anywhere else.
 */
export default function TradePanel({ dao, client, connection, wallet, proposal, busy, send, say, run, onDone }: Props) {
  const [market, setMarket] = useState<"pass" | "fail">("fail");
  const [side, setSide] = useState<"buy" | "sell">("sell");
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState("5");
  const [balances, setBalances] = useState<Record<string, BN> | null>(null);
  const [pools, setPools] = useState<Record<"spot" | "pass" | "fail", Pool> | null>(null);

  const live = proposal.stateName === "pending";
  const settled = proposal.stateName === "passed" || proposal.stateName === "failed";

  // Read the AMM here rather than from the parent's DaoView: that view may predate the
  // launch (pool still "spot", no pass/fail markets in it), and prices move with every
  // trade anyway.
  const refreshPools = useCallback(async () => {
    const fresh: any = await client.getDao(dao.address);
    const fut = fresh?.amm?.state?.futarchy;
    setPools(
      fut
        ? {
            spot: { base: fut.spot.baseReserves, quote: fut.spot.quoteReserves },
            pass: { base: fut.pass.baseReserves, quote: fut.pass.quoteReserves },
            fail: { base: fut.fail.baseReserves, quote: fut.fail.quoteReserves },
          }
        : null,
    );
  }, [client, dao.address]);

  useEffect(() => {
    refreshPools().catch(() => setPools(null));
  }, [refreshPools, proposal.proposal]);

  const price = useCallback(
    (p: Pool) =>
      p.base.isZero() ? 0 : (Number(p.quote.toString()) / 10 ** dao.quoteDecimals) / (Number(p.base.toString()) / 10 ** dao.baseDecimals),
    [dao],
  );

  const pdas = useMemo(
    () => (client as any).getProposalPdas(proposal.proposal, dao.baseMint, dao.quoteMint, dao.address),
    [client, proposal, dao],
  );

  const refreshBalances = useCallback(async () => {
    if (!wallet) return setBalances(null);
    const ata = (m: PublicKey) => getAssociatedTokenAddressSync(m, wallet.publicKey, true);
    const [base, quote, pBase, fBase, pQuote, fQuote] = await Promise.all(
      [dao.baseMint, dao.quoteMint, pdas.passBaseMint, pdas.failBaseMint, pdas.passQuoteMint, pdas.failQuoteMint].map((m: PublicKey) =>
        rawBalance(connection, ata(m)),
      ),
    );
    setBalances({ base, quote, pBase, fBase, pQuote, fQuote });
  }, [wallet, dao, pdas, connection]);

  useEffect(() => {
    refreshBalances().catch(() => setBalances(null));
  }, [refreshBalances]);

  // Constant-product estimate, fee ignored — the slippage allowance has to cover it.
  const estimate = useMemo(() => {
    if (!pools || !amount.trim() || !(Number(amount) > 0)) return null;
    const pool = pools[market];
    const selling = side === "sell";
    const input = uiToRaw(amount, selling ? dao.baseDecimals : dao.quoteDecimals);
    const [rin, rout] = selling ? [pool.base, pool.quote] : [pool.quote, pool.base];
    const out = rout.mul(input).div(rin.add(input));
    const after: Pool = selling
      ? { base: pool.base.add(input), quote: pool.quote.sub(out) }
      : { base: pool.base.sub(out), quote: pool.quote.add(input) };
    const bps = Math.max(0, Math.min(10_000, Math.round(Number(slippage || "0") * 100)));
    return { input, out, minOut: out.mul(new BN(10_000 - bps)).div(new BN(10_000)), priceAfter: price(after) };
  }, [pools, amount, market, side, slippage, dao, price]);

  if (!live && !settled) return null;

  const thresholdBps = proposal.isTeamSponsored ? dao.teamSponsoredPassThresholdBps : dao.passThresholdBps;
  const fmt = (n: number) => (n === 0 ? "0" : n.toPrecision(6));

  return (
    <div className="panel">
      <h2>{live ? "Trade the decision market" : "Redeem conditional tokens"}</h2>
      <p className="sub">
        {live
          ? "Pass if the PASS price ends above the FAIL price by the threshold. Selling in FAIL — selling the NO — backs the proposal with tokens alone."
          : `This proposal ${proposal.stateName}. The winning side redeems 1:1; the losing side is void.`}
      </p>

      {pools && live && (
        <div className="stats">
          {(["pass", "spot", "fail"] as const).map((k) => (
            <div className="stat" key={k}>
              <div className="k">{k.toUpperCase()} price</div>
              <div className="v">{fmt(price(pools[k]))}</div>
            </div>
          ))}
          <div className="stat">
            <div className="k">Pass needs</div>
            <div className="v">
              {thresholdBps >= 0 ? "+" : ""}
              {(thresholdBps / 100).toFixed(2)}
              <small>% vs fail{proposal.isTeamSponsored ? " · sponsored" : ""}</small>
            </div>
          </div>
        </div>
      )}

      {balances && (
        <p className="hint">
          You hold <strong>{rawToUi(balances.base, dao.baseDecimals)}</strong> base ·{" "}
          <strong>{rawToUi(balances.quote, dao.quoteDecimals)}</strong> quote · conditional: pass-base{" "}
          {rawToUi(balances.pBase, dao.baseDecimals)}, fail-base {rawToUi(balances.fBase, dao.baseDecimals)}, pass-quote{" "}
          {rawToUi(balances.pQuote, dao.quoteDecimals)}, fail-quote {rawToUi(balances.fQuote, dao.quoteDecimals)}
        </p>
      )}

      {live && (
        <>
          <div className="row wrap" style={{ marginTop: 12 }}>
            <button className={market === "fail" && side === "sell" ? "tab on" : "tab"} onClick={() => { setMarket("fail"); setSide("sell"); }}>
              Sell the NO (sell base in FAIL)
            </button>
            <button className={market === "pass" && side === "buy" ? "tab on" : "tab"} onClick={() => { setMarket("pass"); setSide("buy"); }}>
              Buy the YES (buy base in PASS)
            </button>
            <button className={market === "pass" && side === "sell" ? "tab on" : "tab"} onClick={() => { setMarket("pass"); setSide("sell"); }}>
              Sell in PASS
            </button>
            <button className={market === "fail" && side === "buy" ? "tab on" : "tab"} onClick={() => { setMarket("fail"); setSide("buy"); }}>
              Buy in FAIL
            </button>
          </div>
          <div className="row wrap" style={{ marginTop: 12 }}>
            <label className="field grow">
              <span>Amount of {side === "sell" ? "base tokens" : "quote (USDC)"} to put in</span>
              <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </label>
            <label className="field" style={{ width: 140 }}>
              <span>Slippage %</span>
              <input inputMode="decimal" value={slippage} onChange={(e) => setSlippage(e.target.value)} />
            </label>
          </div>
          {estimate && (
            <p className="hint">
              Expect ≈ <strong>{rawToUi(estimate.out, side === "sell" ? dao.quoteDecimals : dao.baseDecimals)}</strong>{" "}
              {market}-{side === "sell" ? "quote" : "base"} (min {rawToUi(estimate.minOut, side === "sell" ? dao.quoteDecimals : dao.baseDecimals)}).{" "}
              {market.toUpperCase()} price {fmt(price(pools![market]))} → <strong>{fmt(estimate.priceAfter)}</strong>. Fees are not in this
              estimate; the slippage allowance has to cover them.
            </p>
          )}
          <div className="actions">
            <button
              className="primary"
              disabled={busy || !wallet || !estimate}
              onClick={() =>
                run("trade", async () => {
                  if (!wallet || !estimate) throw new Error("Connect a wallet and enter an amount.");
                  const sig = await tradeConditional(
                    client, connection, dao, proposal.proposal,
                    { market, side, inputAmount: estimate.input, minOutputAmount: estimate.minOut },
                    wallet.publicKey, send, say,
                  );
                  say(`✅ ${side} in ${market.toUpperCase()} — ${sig}`);
                  await Promise.all([refreshBalances(), refreshPools()]);
                  onDone();
                })
              }
            >
              {side === "sell" ? "Split & sell" : "Split & buy"}
            </button>
            <button className="ghost" disabled={busy} onClick={() => { void refreshBalances(); void refreshPools(); }}>
              Refresh prices &amp; balances
            </button>
          </div>
          <p className="hint">
            Two transactions: split your tokens into pass + fail, then swap one side. You keep the other side. If the
            proposal passes, pass-tokens redeem 1:1 and everything on the fail side is void — and the reverse if it fails.
          </p>
        </>
      )}

      {settled && (
        <div className="actions">
          <button
            className="primary"
            disabled={busy || !wallet}
            onClick={() =>
              run("redeem", async () => {
                if (!wallet) throw new Error("Connect a wallet.");
                const sigs = await redeemConditional(client, connection, dao, proposal.proposal, wallet.publicKey, send, say);
                say(`✅ Redeemed — ${sigs.join(" · ")}`);
                await refreshBalances();
              })
            }
          >
            Redeem
          </button>
        </div>
      )}
    </div>
  );
}
