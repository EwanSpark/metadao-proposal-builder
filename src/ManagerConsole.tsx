import { ComputeBudgetProgram, PublicKey, Transaction, type Connection, type TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CoffreClient,
  coffrePda,
  ata,
  saleFloor,
  type CardAccount,
  type CoffreAccount,
  type Listing,
  type SpendingLimit,
} from "./lib/coffre";
import type { SendFn } from "./lib/flow";
import { rawToUi, uiToRaw, type DaoView } from "./lib/futarchy";

type Props = {
  dao: DaoView;
  connection: Connection;
  wallet: { publicKey: PublicKey } | null;
  busy: boolean;
  send: SendFn;
  say: (line: string) => void;
  run: (label: string, fn: () => Promise<void>) => void;
};

type CardRow = CardAccount & { listing_?: Listing | null; held: boolean };

const usdc = (v: BN | bigint) => rawToUi(new BN(v.toString()), 6);

/**
 * The manager's desk. No proposal is involved: the connected wallet must be the
 * coffre's manager and signs every trade itself.
 */
export default function ManagerConsole({ dao, connection, wallet, busy, send, say, run }: Props) {
  // Memoized: a fresh PublicKey object per render would retrigger the load effect forever.
  const multisigKey = dao.multisig.toBase58();
  const coffre = useMemo(() => coffrePda(new PublicKey(multisigKey)), [multisigKey]);
  const [client] = useState(() => new CoffreClient(connection));
  const [state, setState] = useState<CoffreAccount | null | undefined>(undefined);
  const [usdcBalance, setUsdcBalance] = useState<BN>(new BN(0));
  const [limit, setLimit] = useState<SpendingLimit | null>(null);
  const [cards, setCards] = useState<CardRow[]>([]);
  const [buyInput, setBuyInput] = useState("");
  const [buyListing, setBuyListing] = useState<Listing | null>(null);
  const [fundAmount, setFundAmount] = useState("");
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const c = await client.fetchCoffre(coffre);
    setState(c);
    if (!c) return;
    const [bal, lim, cardList, listings] = await Promise.all([
      connection.getTokenAccountBalance(ata(c.usdcMint, coffre)).then((b) => new BN(b.value.amount)).catch(() => new BN(0)),
      c.spendingLimit.equals(PublicKey.default) ? Promise.resolve(null) : client.fetchSpendingLimit(c.spendingLimit),
      client.fetchCards(coffre),
      client.fetchListingsBySeller(coffre),
    ]);
    setUsdcBalance(bal);
    setLimit(lim);
    const held = await Promise.all(
      cardList.map((card) =>
        connection
          .getTokenAccountBalance(ata(card.mint, coffre))
          .then((b) => b.value.amount === "1")
          .catch(() => false),
      ),
    );
    setCards(
      cardList.map((card, i) => ({
        ...card,
        held: held[i],
        listing_: listings.find((l) => l.nft.equals(card.mint)) ?? null,
      })),
    );
  }, [client, coffre, connection]);

  useEffect(() => {
    setState(undefined);
    setError(null);
    reload().catch((e) => {
      setError(e.message ?? String(e));
      say(`⛔ ${e.message ?? e}`);
    });
  }, [reload]);

  const isManager = !!wallet && !!state && state.manager.equals(wallet.publicKey);
  const view = state ? { ...state, address: coffre } : null;

  const sendIx = async (label: string, ix: TransactionInstruction) => {
    if (!wallet) throw new Error("Connect a wallet.");
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 })).add(ix);
    tx.feePayer = wallet.publicKey;
    const sig = await send(tx, connection, {});
    say(`${label} — ${sig}`);
    await reload();
  };

  const resolveBuy = () =>
    run("lookup listing", async () => {
      const l = await client.resolveListing(new PublicKey(buyInput.trim()));
      setBuyListing(l);
      if (!l) throw new Error("No live listing for that address.");
      say(`🔎 ${l.nft.toBase58().slice(0, 8)}… listed at ${usdc(l.price)} USDC by ${l.seller.toBase58().slice(0, 8)}…`);
    });

  const buy = () =>
    run("buy", async () => {
      if (!view || !wallet || !buyListing) throw new Error("Look a listing up first.");
      const market = await client.fetchMarket();
      const autoFund = view.spendingLimit.equals(PublicKey.default)
        ? undefined
        : { multisig: view.multisig, spendingLimit: view.spendingLimit, vault: view.authority };
      const ix = await client.buy(view, wallet.publicKey, new BN(buyListing.price.toString()), {
        asset: buyListing.nft,
        listing: buyListing,
        marketTreasury: market.treasury,
        autoFund,
      });
      await sendIx(`🛒 Bought ${buyListing.nft.toBase58().slice(0, 8)}… for ${usdc(buyListing.price)} USDC`, ix);
      setBuyListing(null);
      setBuyInput("");
    });

  const fund = () =>
    run("fund", async () => {
      if (!view) throw new Error("No coffre.");
      await sendIx(`💧 Pulled ${fundAmount} USDC from the treasury`, await client.fund(view, uiToRaw(fundAmount, 6)));
    });

  const list = (card: CardRow) =>
    run("list", async () => {
      if (!view || !wallet) throw new Error("Connect the manager wallet.");
      const price = uiToRaw(prices[card.mint.toBase58()] ?? "", 6);
      await sendIx(`🏷️ Listed ${card.mint.toBase58().slice(0, 8)}… at ${usdc(price)} USDC`, await client.list(view, wallet.publicKey, card.mint, price));
    });

  const reprice = (card: CardRow) =>
    run("update listing", async () => {
      if (!view || !wallet) throw new Error("Connect the manager wallet.");
      const price = uiToRaw(prices[card.mint.toBase58()] ?? "", 6);
      await sendIx(`🏷️ Re-priced ${card.mint.toBase58().slice(0, 8)}… to ${usdc(price)} USDC`, await client.updateListing(view, wallet.publicKey, card.mint, price));
    });

  const cancel = (card: CardRow) =>
    run("cancel listing", async () => {
      if (!view || !wallet || !card.listing_) throw new Error("Not listed.");
      await sendIx(`↩️ Cancelled listing of ${card.mint.toBase58().slice(0, 8)}…`, await client.cancelListing(view, wallet.publicKey, card.mint, card.listing_.rentPayer));
    });

  const sweep = (card: CardRow) =>
    run("sweep", async () => {
      if (!view) throw new Error("No coffre.");
      await sendIx(`🧹 Swept ${card.mint.toBase58().slice(0, 8)}… (sold)`, await client.sweepSale(view, card.mint));
    });

  if (state === undefined)
    return (
      <div className="panel">
        <h2>Coffre — manager console</h2>
        {error ? <div className="banner">Could not read the coffre: {error}</div> : <div className="empty">Loading…</div>}
      </div>
    );
  if (state === null)
    return (
      <div className="panel">
        <h2>Coffre — manager console</h2>
        <div className="empty">This DAO has no coffre. Initialize it under Create → Coffre.</div>
      </div>
    );

  const periodEnds = Number(state.periodStartedAt.toString()) + state.periodSeconds;
  const limitResets = limit && limit.period !== "OneTime" ? limit.lastReset + { Day: 86400, Week: 604800, Month: 2592000 }[limit.period] : null;

  return (
    <div className="panel">
      <h2>Coffre — manager console</h2>
      <p className="sub">
        Trades happen here without a vote. {isManager ? "You are the manager." : "The connected wallet is not the manager: read-only."}
      </p>

      <div className="stats">
        <div className="stat"><span>Manager</span><b className="mono trunc">{state.manager.equals(PublicKey.default) ? "none" : state.manager.toBase58()}</b></div>
        <div className="stat"><span>USDC in coffre</span><b>{usdc(usdcBalance)}</b></div>
        <div className="stat">
          <span>Budget left this period</span>
          <b>{limit ? `${usdc(limit.remainingAmount)} / ${usdc(limit.amount)} (${limit.period})` : "no spending limit"}</b>
        </div>
        <div className="stat"><span>Limit resets</span><b>{limitResets ? new Date(limitResets * 1000).toLocaleString() : "—"}</b></div>
        <div className="stat">
          <span>Purchases this period</span>
          <b>{state.purchasesThisPeriod} / {state.maxPurchasesPerPeriod || "∞"}{state.periodSeconds ? ` · resets ${new Date(periodEnds * 1000).toLocaleString()}` : ""}</b>
        </div>
        <div className="stat"><span>Max per purchase</span><b>{usdc(state.maxPerTx)} USDC</b></div>
        <div className="stat"><span>Sale floor</span><b>{state.minSaleBps / 100} % of cost basis</b></div>
        <div className="stat"><span>Collection</span><b className="mono trunc">{state.allowedCollection.toBase58()}</b></div>
      </div>

      <h3>Buy</h3>
      <div className="form">
        <label className="field">
          <span>Listing address or NFT mint (from the Collector Crypt listing page)</span>
          <div className="row">
            <input value={buyInput} onChange={(e) => { setBuyInput(e.target.value); setBuyListing(null); }} />
            <button onClick={resolveBuy} disabled={busy || !buyInput.trim()}>Look up</button>
          </div>
        </label>
        {buyListing && (
          <p className="hint">
            {buyListing.nft.toBase58()} · <b>{usdc(buyListing.price)} USDC</b> · seller {buyListing.seller.toBase58().slice(0, 8)}…
            {new BN(buyListing.price.toString()).gt(state.maxPerTx) && " · ⚠️ above max per purchase"}
            {!buyListing.collection.equals(state.allowedCollection) && " · ⚠️ not the allowed collection"}
            {!limit && new BN(buyListing.price.toString()).gt(usdcBalance) && " · ⚠️ coffre balance too low and no spending limit"}
          </p>
        )}
        <div className="actions">
          <button className="primary" onClick={buy} disabled={busy || !isManager || !buyListing}>
            Buy for the fund{limit ? " (tops up from the spending limit if needed)" : ""}
          </button>
        </div>
      </div>

      <h3>Cards ({cards.length})</h3>
      {cards.length === 0 ? (
        <div className="empty">The coffre holds no card.</div>
      ) : (
        <ul className="ixs">
          {cards.map((card) => {
            const key = card.mint.toBase58();
            const floor = saleFloor(card.costBasis, state.minSaleBps);
            return (
              <li key={key} className="ix-card">
                <div className="grow">
                  <div className="t mono trunc">{key}</div>
                  <div className="m">
                    cost {usdc(card.costBasis)} · floor {usdc(floor)} ·{" "}
                    {!card.held ? "SOLD — sweep to close" : card.listing_ ? `listed at ${usdc(card.listing_.price)}` : "held, not listed"}
                    {" "}· since {new Date(Number(card.acquiredAt.toString()) * 1000).toLocaleDateString()}
                  </div>
                  {card.held && isManager && (
                    <div className="row" style={{ marginTop: 6 }}>
                      <input
                        placeholder={`price ≥ ${usdc(floor)}`}
                        value={prices[key] ?? ""}
                        onChange={(e) => setPrices((p) => ({ ...p, [key]: e.target.value }))}
                        style={{ maxWidth: 160 }}
                      />
                      {card.listing_ ? (
                        <>
                          <button className="tiny" onClick={() => reprice(card)} disabled={busy}>Re-price</button>
                          <button className="ghost tiny" onClick={() => cancel(card)} disabled={busy}>Cancel listing</button>
                        </>
                      ) : (
                        <button className="tiny primary" onClick={() => list(card)} disabled={busy}>List</button>
                      )}
                    </div>
                  )}
                </div>
                {!card.held && (
                  <button className="tiny" onClick={() => sweep(card)} disabled={busy || !wallet}>Sweep</button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <h3>Budget</h3>
      <div className="form">
        <label className="field">
          <span>Pull USDC from the treasury into the coffre (anyone may; capped by the spending limit)</span>
          <div className="row">
            <input value={fundAmount} onChange={(e) => setFundAmount(e.target.value)} placeholder="USDC" style={{ maxWidth: 200 }} />
            <button onClick={fund} disabled={busy || !wallet || !limit || !fundAmount.trim()}>Fund</button>
            <button className="ghost" onClick={() => run("refresh coffre", reload)} disabled={busy}>Refresh</button>
          </div>
        </label>
        <p className="hint">
          Sale proceeds land in the coffre automatically. Only a proposal (Create → Coffre → withdraw_usdc)
          can move them back to the treasury.
        </p>
      </div>
    </div>
  );
}
