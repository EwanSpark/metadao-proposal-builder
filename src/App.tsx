import { useAnchorWallet, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import { useCallback, useEffect, useMemo, useState } from "react";
import { GENESIS, RPC_ENDPOINT, RPC_HINT } from "./config";
import {
  authorizationMemo,
  decreaseLiquidity,
  describeInstruction,
  increaseLiquidity,
  jupiterDcaBuyback,
  LIQUIDATION_TEMPLATES,
  parseRawInstructions,
  planBuyback,
  readPositionLiquidity,
  spendFromTreasury,
} from "./lib/actions";
import {
  loadDaoList,
  readCache,
  snapshotDaos,
  SNAPSHOT_CAPTURED_AT,
  writeCache,
  type DaoSummary,
} from "./lib/daos";
import {
  discoverProposals,
  formatDuration,
  resolveProposal,
  secondsRemaining,
  type ProposalRow,
} from "./lib/discover";
import { loadDao, makeClient, rawToUi, uiToRaw, type DaoView } from "./lib/futarchy";
import {
  createSquadsProposal,
  executeVaultTransaction,
  finalizeProposal,
  initializeFutarchyProposal,
  launchProposal,
  sponsorProposal,
  stakeToProposal,
  unstakeFromProposal,
} from "./lib/flow";

type Mode = "create" | "stake" | "finalize";
type ActionKind = "spend" | "buyback" | "addLiq" | "removeLiq" | "liquidate" | "raw";

type Props = Record<string, never>;

const STATE_LABEL: Record<string, string> = {
  draft: "Draft",
  pending: "Live",
  passed: "Passed",
  failed: "Failed",
  removed: "Removed",
};

export default function App(_: Props) {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { sendTransaction } = useWallet();

  const [cluster, setCluster] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<Mode>("create");

  const [daoAddress, setDaoAddress] = useState("");
  const [dao, setDao] = useState<DaoView | null>(null);
  const [daoList, setDaoList] = useState<DaoSummary[]>(() => snapshotDaos());
  const [daoListSource, setDaoListSource] = useState<"rpc" | "snapshot">("snapshot");
  const [daoFilter, setDaoFilter] = useState("");

  const [kind, setKind] = useState<ActionKind>("spend");
  const [pending, setPending] = useState<TransactionInstruction[]>([]);
  const [spendTo, setSpendTo] = useState("");
  const [spendAmount, setSpendAmount] = useState("");
  const [spendCreateAta, setSpendCreateAta] = useState(true);
  const [liqQuote, setLiqQuote] = useState("");
  const [liqMaxBase, setLiqMaxBase] = useState("");
  const [liqToRemove, setLiqToRemove] = useState("");
  const [bbTotal, setBbTotal] = useState("");
  const [bbOrders, setBbOrders] = useState("8640");
  const [bbInterval, setBbInterval] = useState("300");
  const [bbMaxPrice, setBbMaxPrice] = useState("");
  const [memoText, setMemoText] = useState(LIQUIDATION_TEMPLATES[0].text);
  const [rawJson, setRawJson] = useState("");

  const [rows, setRows] = useState<ProposalRow[]>([]);
  const [selected, setSelected] = useState<ProposalRow | null>(null);
  const [manualProposal, setManualProposal] = useState("");
  const [stakeAmount, setStakeAmount] = useState("");

  const client = useMemo(() => makeClient(connection, (wallet as any) ?? null), [connection, wallet]);

  useEffect(() => {
    if (cluster) {
      const cached = readCache(cluster);
      if (cached) setDaoList(cached);
    }
  }, [cluster]);

  useEffect(() => {
    let alive = true;
    connection
      .getGenesisHash()
      .then((h) => alive && setCluster((GENESIS as Record<string, string>)[h] ?? "unknown cluster"))
      .catch(() => alive && setCluster("unreachable"));
    return () => {
      alive = false;
    };
  }, [connection]);

  const say = useCallback((line: string) => {
    setLog((l) => [`${new Date().toLocaleTimeString()}  ${line}`, ...l].slice(0, 200));
  }, []);

  const run = useCallback(
    async (label: string, fn: () => Promise<void>) => {
      setBusy(true);
      try {
        await fn();
      } catch (e: any) {
        say(`❌ ${label} — ${e?.message ?? String(e)}`);
        if (e?.logs) say(e.logs.slice(-6).join(" | "));
      } finally {
        setBusy(false);
      }
    },
    [say],
  );

  /* ------------------------------------------------------------------ DAO */

  const doListDaos = () =>
    run("DAO list", async () => {
      const { daos, source, reason } = await loadDaoList(connection, client);
      setDaoList(daos);
      setDaoListSource(source);
      if (source === "rpc") {
        writeCache(cluster ?? RPC_ENDPOINT, daos);
        say(`📚 ${daos.length} DAOs listed live (${daos.filter((d) => d.symbol).length} named).`);
      } else {
        say(`📚 Bundled snapshot: ${daos.length} DAOs. This RPC refuses getProgramAccounts.`);
        say(`   ↳ ${reason}`);
      }
    });

  const doLoadDao = (address?: string) =>
    run("loading DAO", async () => {
      const pk = new PublicKey((address ?? daoAddress).trim());
      setDaoAddress(pk.toBase58());
      const view = await loadDao(client, connection, pk);
      setDao(view);
      setRows([]);
      setSelected(null);
      say(`✅ DAO loaded — ${view.proposalCount} proposals, pool ${view.poolPhase}`);
      if (view.poolPhase === "futarchy")
        say("⚠️ A proposal is already live — no other launch will succeed.");
    });

  const doDiscover = () =>
    run("discovering proposals", async () => {
      if (!dao) throw new Error("Load a DAO first.");
      const found = await discoverProposals(connection, client, dao);
      setRows(found);
      say(`🔎 ${found.length} proposal(s) found.`);
    });

  const doResolveManual = () =>
    run("resolving proposal", async () => {
      const row = await resolveProposal(client, connection, new PublicKey(manualProposal.trim()));
      setRows((r) => [row, ...r.filter((x) => !x.proposal.equals(row.proposal))]);
      setSelected(row);
      say(`✅ Proposal #${row.number} — ${row.stateName} — Squads tx #${row.transactionIndex}`);
    });

  const reselect = useCallback(
    async (row: ProposalRow) => {
      const fresh = await resolveProposal(client, connection, row.proposal);
      setSelected(fresh);
      setRows((r) => r.map((x) => (x.proposal.equals(fresh.proposal) ? fresh : x)));
      if (dao) setDao(await loadDao(client, connection, dao.address));
      return fresh;
    },
    [client, connection, dao],
  );

  const doRefreshSelected = () =>
    run("refresh", async () => {
      if (!selected) return;
      const fresh = await reselect(selected);
      say(`🔄 #${fresh.number} — ${fresh.stateName}`);
    });

  /* -------------------------------------------------------------- actions */

  const addAction = () =>
    run("building action", async () => {
      if (!dao) throw new Error("Load a DAO first.");
      let ixs: TransactionInstruction[] = [];

      if (kind === "spend") {
        ixs = spendFromTreasury(
          dao,
          new PublicKey(spendTo.trim()),
          uiToRaw(spendAmount, dao.quoteDecimals),
          spendCreateAta,
        );
      } else if (kind === "buyback") {
        const params = {
          totalIn: uiToRaw(bbTotal, dao.quoteDecimals),
          orders: Number(bbOrders),
          intervalSeconds: Number(bbInterval),
          maxPrice: bbMaxPrice.trim() ? Number(bbMaxPrice) : null,
        };
        const plan = planBuyback(dao, params);
        ixs = jupiterDcaBuyback(dao, params, plan);
        say(
          `ℹ️ DCA ${plan.dca.toBase58().slice(0, 8)}… — ${rawToUi(plan.perCycle, dao.quoteDecimals)} per order` +
            (plan.minOutPerCycle
              ? `, min ${rawToUi(plan.minOutPerCycle, dao.baseDecimals)} base/order`
              : ", no max price"),
        );
      } else if (kind === "addLiq") {
        ixs = await increaseLiquidity(
          client,
          dao,
          uiToRaw(liqQuote, dao.quoteDecimals),
          uiToRaw(liqMaxBase, dao.baseDecimals),
        );
      } else if (kind === "removeLiq") {
        const held = await readPositionLiquidity(client, dao);
        if (!held) throw new Error("The treasury holds no LP position in this DAO.");
        const amount = liqToRemove.trim() ? new BN(liqToRemove.trim()) : held;
        if (amount.gt(held))
          throw new Error(`Position available: ${held.toString()} liquidity units.`);
        ixs = await decreaseLiquidity(client, dao, amount, new BN(0), new BN(0));
        say(`ℹ️ Withdrawing ${amount.toString()} / ${held.toString()} liquidity units.`);
      } else if (kind === "liquidate") {
        ixs = authorizationMemo(memoText);
        say("ℹ️ Signalling mandate — nothing moves on-chain at execution.");
      } else {
        ixs = parseRawInstructions(rawJson);
      }

      setPending((p) => [...p, ...ixs]);
      say(`➕ ${ixs.length} instruction(s) added.`);
    });

  /* ------------------------------------------------------------- lifecycle */

  const doCreate = () =>
    run("creating proposal", async () => {
      if (!dao || !wallet) throw new Error("Wallet or DAO missing.");
      if (pending.length === 0) throw new Error("Add at least one instruction.");

      say("1/2 — Squads vault transaction + proposal…");
      const created = await createSquadsProposal(
        connection,
        dao,
        pending,
        wallet.publicKey,
        sendTransaction as any,
      );
      say(`✅ Squads proposal #${created.transactionIndex} — ${created.signature}`);

      say("2/2 — binary question + conditional vaults + futarchy proposal (3 tx)…");
      const p = await initializeFutarchyProposal(client, dao, created.squadsProposal);
      say(`✅ Futarchy proposal: ${p.toBase58()} — Draft state`);

      // Retry: the account was just written, a lagging RPC node may not see it yet.
      const row = await resolveProposal(client, connection, p, 8);
      setRows((r) => [row, ...r]);
      setSelected(row);
      setPending([]);
      setMode("stake");
      say("➡️ Move to the Stake & Launch tab.");
    });

  const doStake = () =>
    run("stake", async () => {
      if (!dao || !selected) throw new Error("Select a proposal.");
      const sig = await stakeToProposal(
        client,
        dao,
        selected.proposal,
        uiToRaw(stakeAmount, dao.baseDecimals),
      );
      say(`✅ Staked — ${sig}`);
      await reselect(selected);
    });

  const doUnstake = () =>
    run("unstake", async () => {
      if (!dao || !selected) throw new Error("Select a proposal.");
      const sig = await unstakeFromProposal(
        client,
        dao,
        selected.proposal,
        uiToRaw(stakeAmount, dao.baseDecimals),
      );
      say(`✅ Unstaked — ${sig}`);
      await reselect(selected);
    });

  const doSponsor = () =>
    run("sponsor", async () => {
      if (!dao || !selected) throw new Error("Select a proposal.");
      say(`ℹ️ Requires the team_address signature (${dao.teamAddress.toBase58()}).`);
      const sig = await sponsorProposal(client, dao, selected.proposal);
      say(`✅ Sponsored — threshold ${dao.teamSponsoredPassThresholdBps} bps — ${sig}`);
      await reselect(selected);
    });

  const doLaunch = () =>
    run("launch", async () => {
      if (!dao || !selected) throw new Error("Select a proposal.");
      if (dao.poolPhase === "futarchy")
        throw new Error("A proposal is already live on this DAO (PoolNotInSpotState).");
      const sig = await launchProposal(client, dao, selected.proposal, selected.squadsProposal);
      say(`🚀 Launched — ${dao.secondsPerProposal / 86400} days of market — ${sig}`);
      await reselect(selected);
    });

  const doFinalize = () =>
    run("finalize", async () => {
      if (!selected) throw new Error("Select a proposal.");
      const sig = await finalizeProposal(client, selected.proposal);
      say(`🏁 Finalized — ${sig}`);
      await reselect(selected);
    });

  const doExecute = () =>
    run("execution", async () => {
      if (!dao || !wallet || !selected) throw new Error("Select a proposal.");
      const sig = await executeVaultTransaction(
        connection,
        dao,
        selected.transactionIndex,
        wallet.publicKey,
        sendTransaction as any,
      );
      say(`✅ Vault transaction executed — ${sig}`);
    });

  /* ------------------------------------------------------------------ view */

  const [buybackPreview, buybackError] = useMemo(() => {
    if (kind !== "buyback" || !dao || !bbTotal.trim()) return [null, null] as const;
    try {
      const params = {
        totalIn: uiToRaw(bbTotal, dao.quoteDecimals),
        orders: Number(bbOrders),
        intervalSeconds: Number(bbInterval),
        maxPrice: bbMaxPrice.trim() ? Number(bbMaxPrice) : null,
      };
      const plan = planBuyback(dao, params);
      return [
        {
          perCycle: rawToUi(plan.perCycle, dao.quoteDecimals),
          minOut: plan.minOutPerCycle ? rawToUi(plan.minOutPerCycle, dao.baseDecimals) : null,
          duration: formatDuration(plan.durationSeconds),
          dca: plan.dca.toBase58(),
          cycles: plan.effectiveOrders,
          dust: plan.dust.isZero() ? null : rawToUi(plan.dust, dao.quoteDecimals),
        },
        null,
      ] as const;
    } catch (e: any) {
      return [null, e?.message ?? String(e)] as const;
    }
  }, [kind, dao, bbTotal, bbOrders, bbInterval, bbMaxPrice]);

  const visibleDaos = useMemo(() => {
    const q = daoFilter.trim().toLowerCase();
    if (!q) return daoList;
    return daoList.filter((d) =>
      [d.name, d.symbol, d.address.toBase58()].some((s) => s?.toLowerCase().includes(q)),
    );
  }, [daoList, daoFilter]);

  const goal = dao?.baseToStake ?? new BN(0);
  const staked = selected?.amountStaked ?? new BN(0);
  const stakePct =
    !goal.isZero() && selected
      ? Math.min(100, (Number(staked.toString()) / Number(goal.toString())) * 100)
      : 0;
  const stakeMet = selected ? staked.gte(goal) || selected.isTeamSponsored : false;
  const remaining = selected ? secondsRemaining(selected) : null;
  const stakeMissing = dao && selected ? goal.sub(staked) : null;

  /** Ce qu'il faut faire maintenant, en une phrase. */
  const nextStep = (() => {
    if (!wallet) return "Connect a wallet to act. Reading works without one.";
    if (!dao) return "Load a DAO: pick one from the list or paste its address.";
    if (mode === "create")
      return pending.length === 0
        ? "Compose what the proposal will execute, then add it to the list."
        : `${pending.length} instruction(s) ready — click “Create proposal”.`;
    if (!selected) return "Select a proposal from the list above.";
    if (selected.stateName === "draft" && !stakeMet && dao)
      return `${rawToUi(stakeMissing!, dao.baseDecimals)} more tokens must be staked before the vote can launch.`;
    if (selected.stateName === "draft") return "Threshold reached — you can launch the vote.";
    if (selected.stateName === "pending" && remaining !== null && remaining > 0)
      return `Vote in progress, ends in ${formatDuration(remaining)}. Nothing to do until then.`;
    if (selected.stateName === "pending") return "Duration elapsed — the proposal can be finalized.";
    if (selected.stateName === "passed") return "Passed. Execute the vault transaction to apply the instructions.";
    if (selected.stateName === "failed") return "Rejected by the market. Nothing to execute.";
    return "Proposal removed.";
  })();

  const picker = (
    <>
      <div className="row wrap">
        <button onClick={doDiscover} disabled={busy || !dao}>
          List the DAO's proposals
        </button>
        <input
          className="grow"
          placeholder="…or paste a proposal address"
          value={manualProposal}
          onChange={(e) => setManualProposal(e.target.value)}
        />
        <button className="ghost" onClick={doResolveManual} disabled={busy || !manualProposal}>
          Load
        </button>
      </div>

      {rows.length > 0 && (
        <ul className="rows">
          {rows.map((r) => {
            const rem = secondsRemaining(r);
            return (
              <li
                key={r.proposal.toBase58()}
                className={selected?.proposal.equals(r.proposal) ? "row-item on" : "row-item"}
                onClick={() => setSelected(r)}
              >
                <span className="num">#{r.number}</span>
                <span className={`pill ${r.stateName}`}>
                  {STATE_LABEL[r.stateName] ?? r.stateName}
                </span>
                <span className="mono grow">{r.proposal.toBase58().slice(0, 16)}…</span>
                {r.stateName === "draft" && dao && (
                  <span className="hint">
                    {rawToUi(r.amountStaked, dao.baseDecimals)} /{" "}
                    {rawToUi(dao.baseToStake, dao.baseDecimals)} staked
                  </span>
                )}
                {rem !== null && r.stateName === "pending" && (
                  <span className="hint">{formatDuration(rem)}</span>
                )}
                {r.isTeamSponsored && <span className="pill team">team</span>}
              </li>
            );
          })}
        </ul>
      )}

      {selected && (
        <table className="kv">
          <tbody>
            <tr>
              <td>Proposal</td>
              <td className="mono">{selected.proposal.toBase58()}</td>
            </tr>
            <tr>
              <td>Squads tx index</td>
              <td className="mono">{selected.transactionIndex.toString()}</td>
            </tr>
            <tr>
              <td>State</td>
              <td>
                {STATE_LABEL[selected.stateName] ?? selected.stateName}
                {selected.isTeamSponsored && " · team-sponsored"}
              </td>
            </tr>
            {remaining !== null && (
              <tr>
                <td>Vote ends</td>
                <td>{formatDuration(remaining)}</td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </>
  );

  const ACTION_INFO: Record<ActionKind, { title: string; sub: string }> = {
    spend: { title: "Spend from treasury", sub: "Send quote tokens from the DAO treasury to any address." },
    buyback: { title: "Buyback via Jupiter DCA", sub: "Open a recurring order that buys the DAO's own token over time." },
    addLiq: { title: "Add liquidity", sub: "Deposit treasury funds into the futarchy AMM, deepening decision markets." },
    removeLiq: { title: "Remove liquidity", sub: "Pull part of the treasury's LP position back into the treasury." },
    liquidate: { title: "Liquidation mandate", sub: "A memo the market votes on. Transfers nothing by itself." },
    raw: { title: "Raw instruction", sub: "Paste JSON for anything the forms don't cover." },
  };
  const info = ACTION_INFO[kind];
  const removeAt = (i: number) => setPending((p) => p.filter((_, j) => j !== i));

  const linkify = (text: string) =>
    text.split(/(\b[1-9A-HJ-NP-Za-km-z]{86,90}\b)/g).map((part, i) =>
      /^[1-9A-HJ-NP-Za-km-z]{86,90}$/.test(part) ? (
        <a key={i} href={`https://solscan.io/tx/${part}`} target="_blank" rel="noreferrer">
          {part.slice(0, 14)}…
        </a>
      ) : (
        <span key={i}>{part}</span>
      ),
    );

  const steps: [Mode, string, string][] = [
    ["create", "Create", "Compose and submit"],
    ["stake", "Stake & launch", "Reach the threshold"],
    ["finalize", "Finalize & execute", "After the vote"],
  ];

  return (
    <>
      <div className="topbar">
        <div className="topbar-in">
          <div className="brand">
            MetaDAO <span>· Proposal Builder</span>
          </div>
          <span className={cluster === "mainnet-beta" ? "cluster live" : "cluster"}>
            {cluster ?? "connecting…"}
          </span>
          <WalletMultiButton />
        </div>
      </div>

      <div className="app">
        {cluster === "mainnet-beta" && (
          <div className="banner">Mainnet — every button sends a real, irreversible transaction.</div>
        )}
        {cluster === "unreachable" && (
          <div className="banner">
            No RPC reachable. Set <span className="mono">RPC_URL</span> in{" "}
            <span className="mono">.env.local</span> and restart, or add it as a Cloudflare secret.
          </div>
        )}

        <div className="panel">
          <h2>DAO</h2>
          <p className="sub">
            {dao
              ? "Loaded. Pick another below to switch."
              : "Choose the DAO you want to act on. Reading works without a wallet."}
          </p>

          {dao && (
            <>
              <div className="stats">
                <div className="stat">
                  <div className="k">Spot price</div>
                  <div className="v">{dao.spotPrice !== null ? dao.spotPrice.toPrecision(4) : "—"}</div>
                </div>
                <div className="stat">
                  <div className="k">Pool depth</div>
                  <div className="v">
                    {rawToUi(dao.spot.quote, dao.quoteDecimals, 0)} <small>quote</small>
                  </div>
                </div>
                <div className="stat">
                  <div className="k">Stake to launch</div>
                  <div className="v">{rawToUi(dao.baseToStake, dao.baseDecimals, 0)}</div>
                </div>
                <div className="stat">
                  <div className="k">Vote length</div>
                  <div className="v">
                    {dao.secondsPerProposal / 86400} <small>days</small>
                  </div>
                </div>
              </div>
              <p className="hint">
                {dao.poolPhase === "spot" ? (
                  <>No proposal is live — a launch is possible.</>
                ) : (
                  <>
                    <strong>A proposal is live.</strong> The pool is split into pass/fail; no other
                    launch will succeed until it is finalized.
                  </>
                )}
              </p>

              <details className="more">
                <summary>DAO details</summary>
                <table className="kv">
                  <tbody>
                    <tr>
                      <td>Treasury</td>
                      <td className="mono">
                        <a
                          href={`https://solscan.io/account/${dao.treasury.toBase58()}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {dao.treasury.toBase58()}
                        </a>
                      </td>
                    </tr>
                    <tr>
                      <td>Spot reserves</td>
                      <td>
                        {rawToUi(dao.spot.base, dao.baseDecimals)} base ·{" "}
                        {rawToUi(dao.spot.quote, dao.quoteDecimals)} quote
                      </td>
                    </tr>
                    <tr>
                      <td>To pass</td>
                      <td>
                        pass price must exceed fail by {dao.passThresholdBps / 100}%
                        {dao.teamSponsoredPassThresholdBps !== dao.passThresholdBps &&
                          ` (${dao.teamSponsoredPassThresholdBps / 100}% if team-sponsored)`}
                      </td>
                    </tr>
                    <tr>
                      <td>TWAP delay</td>
                      <td>
                        first {dao.twapStartDelaySeconds / 3600} hours don't count toward the TWAP
                      </td>
                    </tr>
                    <tr>
                      <td>Team address</td>
                      <td className="mono">{dao.teamAddress.toBase58()}</td>
                    </tr>
                  </tbody>
                </table>
              </details>
            </>
          )}

          <div className="row wrap" style={{ marginTop: dao ? 16 : 0 }}>
            <input
              className="grow"
              placeholder="Filter by name, symbol or address"
              value={daoFilter}
              onChange={(e) => setDaoFilter(e.target.value)}
            />
            <button className="ghost" onClick={doListDaos} disabled={busy}>
              Refresh
            </button>
          </div>

          {visibleDaos.length > 0 ? (
            <div className="dao-list">
              {visibleDaos.slice(0, 60).map((d) => (
                <button
                  key={d.address.toBase58()}
                  className={dao?.address.equals(d.address) ? "dao-row on" : "dao-row"}
                  onClick={() => doLoadDao(d.address.toBase58())}
                  disabled={busy}
                >
                  <span className="sym">{d.symbol ?? "—"}</span>
                  <span className="nm trunc">{d.name ?? d.address.toBase58()}</span>
                  <span className="ct">
                    {d.proposalCount} {d.proposalCount === 1 ? "proposal" : "proposals"}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="empty" style={{ marginTop: 12 }}>
              No DAO matches “{daoFilter}”.
            </div>
          )}

          <div className="row" style={{ marginTop: 10 }}>
            <input
              className="grow mono"
              placeholder="…or paste a Dao account address"
              value={daoAddress}
              onChange={(e) => setDaoAddress(e.target.value)}
            />
            <button className="ghost" onClick={() => doLoadDao()} disabled={busy}>
              Load
            </button>
          </div>
          <p className="hint">
            {daoListSource === "rpc"
              ? "Live list from the program."
              : `Bundled snapshot from ${new Date(SNAPSHOT_CAPTURED_AT).toLocaleDateString()} — refresh with an RPC that allows getProgramAccounts.`}
          </p>
        </div>

        <div className="stepper">
          {steps.map(([m, t, d], i) => (
            <button
              key={m}
              className={`step${mode === m ? " on" : ""}${
                (m === "create" && selected) || (m === "stake" && selected?.stateName === "passed")
                  ? " done"
                  : ""
              }`}
              onClick={() => setMode(m)}
            >
              <div className="t">
                <span className="n">{i + 1}</span>
                {t}
              </div>
              <div className="d">{d}</div>
            </button>
          ))}
        </div>

        <div className="next">
          <b>Next</b>
          <span>{nextStep}</span>
        </div>

        {mode === "create" && (
          <div className="panel">
            <h2>{info.title}</h2>
            <p className="sub">{info.sub}</p>

            <div className="tabs">
              {(
                [
                  ["spend", "Spend"],
                  ["buyback", "Buyback"],
                  ["addLiq", "Add liquidity"],
                  ["removeLiq", "Remove liquidity"],
                  ["liquidate", "Liquidation"],
                  ["raw", "Raw"],
                ] as [ActionKind, string][]
              ).map(([k, label]) => (
                <button key={k} className={kind === k ? "tab on" : "tab"} onClick={() => setKind(k)}>
                  {label}
                </button>
              ))}
            </div>

            {kind === "spend" && (
              <div className="form">
                <label className="field">
                  <span>Recipient wallet</span>
                  <input value={spendTo} onChange={(e) => setSpendTo(e.target.value)} />
                </label>
                <label className="field">
                  <span>Amount (quote tokens)</span>
                  <input value={spendAmount} onChange={(e) => setSpendAmount(e.target.value)} />
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={spendCreateAta}
                    onChange={(e) => setSpendCreateAta(e.target.checked)}
                  />
                  Create the recipient's token account (rent paid by the treasury)
                </label>
              </div>
            )}

            {kind === "buyback" && (
              <div className="form">
                <label className="field">
                  <span>Total to spend (quote tokens)</span>
                  <input value={bbTotal} onChange={(e) => setBbTotal(e.target.value)} />
                </label>
                <div className="row wrap">
                  <label className="field">
                    <span>Orders</span>
                    <input value={bbOrders} onChange={(e) => setBbOrders(e.target.value)} />
                  </label>
                  <label className="field">
                    <span>Interval (seconds)</span>
                    <input value={bbInterval} onChange={(e) => setBbInterval(e.target.value)} />
                  </label>
                  <label className="field">
                    <span>Max price (optional)</span>
                    <input value={bbMaxPrice} onChange={(e) => setBbMaxPrice(e.target.value)} />
                  </label>
                </div>

                {buybackPreview && (
                  <div className="stats">
                    <div className="stat">
                      <div className="k">Per order</div>
                      <div className="v">{buybackPreview.perCycle}</div>
                    </div>
                    <div className="stat">
                      <div className="k">Min received / order</div>
                      <div className="v">{buybackPreview.minOut ?? "—"}</div>
                    </div>
                    <div className="stat">
                      <div className="k">Cycles</div>
                      <div className="v">{buybackPreview.cycles}</div>
                    </div>
                    <div className="stat">
                      <div className="k">Duration</div>
                      <div className="v">{buybackPreview.duration}</div>
                    </div>
                  </div>
                )}
                {buybackError && <p className="hint">⚠️ {buybackError}</p>}
                <p className="hint">
                  The “max price” is encoded as <span className="mono">minOutAmount</span> per cycle.
                  Bought tokens land in the DCA account and stay there until a cancellation proposal.
                </p>
              </div>
            )}

            {kind === "addLiq" && (
              <div className="form">
                <div className="row wrap">
                  <label className="field">
                    <span>Quote to deposit</span>
                    <input value={liqQuote} onChange={(e) => setLiqQuote(e.target.value)} />
                  </label>
                  <label className="field">
                    <span>Max base to deposit</span>
                    <input value={liqMaxBase} onChange={(e) => setLiqMaxBase(e.target.value)} />
                  </label>
                </div>
              </div>
            )}

            {kind === "removeLiq" && (
              <div className="form">
                <label className="field">
                  <span>Liquidity units — leave empty to withdraw the whole position</span>
                  <input value={liqToRemove} onChange={(e) => setLiqToRemove(e.target.value)} />
                </label>
                <p className="hint">
                  Emptying the pool leaves the DAO unable to launch any proposal, and governance
                  cannot undo it — only a permissionless refill can.
                </p>
              </div>
            )}

            {kind === "liquidate" && (
              <div className="form">
                <div className="row wrap">
                  {LIQUIDATION_TEMPLATES.map((t) => (
                    <button key={t.label} className="tab" onClick={() => setMemoText(t.text)}>
                      {t.label}
                    </button>
                  ))}
                </div>
                <textarea rows={4} value={memoText} onChange={(e) => setMemoText(e.target.value)} />
                <p className="hint">
                  Both real liquidations on mainnet are a single SPL memo with zero accounts — a
                  mandate MetaDAO then executes with its own authorities, outside governance.
                </p>
              </div>
            )}

            {kind === "raw" && (
              <div className="form">
                <textarea
                  rows={7}
                  placeholder='[{"programId":"…","keys":[{"pubkey":"…","isSigner":false,"isWritable":true}],"data":"base64"}]'
                  value={rawJson}
                  onChange={(e) => setRawJson(e.target.value)}
                />
              </div>
            )}

            <div className="actions">
              <button className="primary" onClick={addAction} disabled={busy || !dao}>
                Add to proposal
              </button>
            </div>

            {pending.length > 0 ? (
              <>
                <ul className="ixs">
                  {pending.map((ix, i) => (
                    <li key={i} className="ix-card">
                      <span className="n">{i + 1}</span>
                      <div className="body">
                        <div className="t">{describeInstruction(ix)}</div>
                        <div className="m mono">{ix.programId.toBase58()}</div>
                      </div>
                      <button className="ghost tiny" onClick={() => removeAt(i)} disabled={busy}>
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="actions">
                  <button className="primary" onClick={doCreate} disabled={busy || !dao || !wallet}>
                    Create proposal ({pending.length})
                  </button>
                  <button className="ghost" onClick={() => setPending([])} disabled={busy}>
                    Clear
                  </button>
                </div>
              </>
            ) : (
              <div className="empty" style={{ marginTop: 16 }}>
                Nothing queued yet. Build an action above and add it.
              </div>
            )}
          </div>
        )}

        {mode === "stake" && (
          <div className="panel">
            <h2>Stake &amp; launch</h2>
            <p className="sub">
              A proposal only goes to market once enough tokens back it. The stake is returned 5
              seconds after launch.
            </p>
            {picker}

            {selected && dao && selected.stateName === "draft" && (
              <>
                <div className={stakeMet ? "bar done" : "bar"} style={{ marginTop: 18 }}>
                  <div style={{ width: `${stakePct}%` }} />
                </div>
                <p className="hint">
                  <strong>{rawToUi(staked, dao.baseDecimals)}</strong> staked of{" "}
                  {rawToUi(goal, dao.baseDecimals)} required
                  {stakeMet
                    ? " — threshold reached"
                    : ` — ${rawToUi(stakeMissing!, dao.baseDecimals)} short`}
                </p>

                <div className="actions">
                  <input
                    placeholder="Amount"
                    value={stakeAmount}
                    onChange={(e) => setStakeAmount(e.target.value)}
                    style={{ width: 150 }}
                  />
                  <button className="primary" onClick={doStake} disabled={busy || !wallet}>
                    Stake
                  </button>
                  <button className="ghost" onClick={doUnstake} disabled={busy || !wallet}>
                    Unstake
                  </button>
                  <button className="ghost" onClick={doSponsor} disabled={busy || !wallet}>
                    Sponsor as team
                  </button>
                </div>

                <div className="actions">
                  <button className="primary" onClick={doLaunch} disabled={busy || !wallet || !stakeMet}>
                    Launch vote
                  </button>
                  <button className="ghost" onClick={doRefreshSelected} disabled={busy}>
                    Refresh
                  </button>
                </div>
              </>
            )}

            {selected && selected.stateName !== "draft" && (
              <p className="hint">
                This proposal is {STATE_LABEL[selected.stateName]?.toLowerCase()}. Staking and
                launching only apply to drafts.
              </p>
            )}
          </div>
        )}

        {mode === "finalize" && (
          <div className="panel">
            <h2>Finalize &amp; execute</h2>
            <p className="sub">
              Two separate transactions: finalizing resolves the market, executing applies the
              instructions.
            </p>
            {picker}

            {selected && (
              <>
                <div className="actions">
                  <button
                    className="primary"
                    onClick={doFinalize}
                    disabled={busy || !wallet || selected.stateName !== "pending"}
                  >
                    Finalize
                  </button>
                  <button
                    className="primary"
                    onClick={doExecute}
                    disabled={busy || !wallet || selected.stateName !== "passed"}
                  >
                    Execute vault transaction
                  </button>
                  <button className="ghost" onClick={doRefreshSelected} disabled={busy}>
                    Refresh
                  </button>
                </div>
                <p className="hint">
                  Finalizing only works once the vote duration has elapsed. Execution is a separate
                  transaction because the Solana runtime forbids futarchy&nbsp;→&nbsp;squads&nbsp;→&nbsp;futarchy
                  in one stack.
                </p>
              </>
            )}
          </div>
        )}

        <div className="panel">
          <h2>Activity</h2>
          <p className="sub">{RPC_HINT}</p>
          {log.length === 0 ? (
            <div className="empty">Nothing yet.</div>
          ) : (
            <ul className="feed">
              {log.map((line, i) => {
                const sep = line.indexOf("  ");
                return (
                  <li key={i}>
                    <span className="ts">{line.slice(0, sep)}</span>
                    <span className="msg">{linkify(line.slice(sep + 2))}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}
