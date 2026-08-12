import { useAnchorWallet, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import { useCallback, useMemo, useState } from "react";
import { NETWORKS, RPC_HINT, type NetworkId } from "./config";
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
  daoLabel,
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

type Props = {
  network: NetworkId;
  setNetwork: (n: NetworkId) => void;
  customRpc: string;
  setCustomRpc: (s: string) => void;
  endpoint: string;
};

const STATE_LABEL: Record<string, string> = {
  draft: "Draft",
  pending: "Live",
  passed: "Passed",
  failed: "Failed",
  removed: "Removed",
};

export default function App({ network, setNetwork, customRpc, setCustomRpc, endpoint }: Props) {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { sendTransaction } = useWallet();

  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<Mode>("create");

  const [daoAddress, setDaoAddress] = useState("");
  const [dao, setDao] = useState<DaoView | null>(null);
  const [daoList, setDaoList] = useState<DaoSummary[]>(() => readCache(endpoint) ?? snapshotDaos());
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
        writeCache(endpoint, daos);
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

  return (
    <div className="app">
      <header>
        <h1>MetaDAO · Proposal Builder</h1>
        <div className="row">
          <select value={network} onChange={(e) => setNetwork(e.target.value as NetworkId)}>
            <option value="devnet">{NETWORKS.devnet.label}</option>
            <option value="mainnet">{NETWORKS.mainnet.label}</option>
            <option value="custom">RPC custom</option>
          </select>
          {network === "custom" && (
            <input
              placeholder="https://…"
              value={customRpc}
              onChange={(e) => setCustomRpc(e.target.value)}
            />
          )}
          <WalletMultiButton />
        </div>
      </header>

      {network === "mainnet" && (
        <div className="warn">
          ⚠️ Mainnet — every button sends a real, irreversible transaction.
        </div>
      )}
      <p className="hint">{RPC_HINT}</p>

      <section>
        <h2>DAO</h2>

        <div className="row wrap">
          <button onClick={doListDaos} disabled={busy}>
            Refresh list
          </button>
          {daoList.length > 0 && (
            <input
              className="grow"
              placeholder="Filter (name, symbol, address)"
              value={daoFilter}
              onChange={(e) => setDaoFilter(e.target.value)}
            />
          )}
        </div>

        {daoList.length > 0 && (
          <select
            className="picker"
            size={Math.min(10, visibleDaos.length + 1)}
            value={daoAddress}
            onChange={(e) => doLoadDao(e.target.value)}
          >
            <option value="" disabled>
              {visibleDaos.length} DAOs — select one to load
            </option>
            {visibleDaos.map((d) => (
              <option key={d.address.toBase58()} value={d.address.toBase58()}>
                {daoLabel(d)}
              </option>
            ))}
          </select>
        )}

        <p className="hint">
          {daoListSource === "rpc"
            ? "Live list from the program."
            : `Bundled snapshot from ${new Date(SNAPSHOT_CAPTURED_AT).toLocaleDateString()} — refresh with an RPC that allows getProgramAccounts (Helius, Triton).`}
        </p>

        <div className="row">
          <input
            className="grow"
            placeholder="…or paste a Dao account address"
            value={daoAddress}
            onChange={(e) => setDaoAddress(e.target.value)}
          />
          <button onClick={() => doLoadDao()} disabled={busy}>
            Load
          </button>
        </div>

        {dao && (
          <table className="kv">
            <tbody>
              <tr>
                <td>Treasury</td>
                <td className="mono">{dao.treasury.toBase58()}</td>
              </tr>
              <tr>
                <td>Spot pool</td>
                <td>
                  {rawToUi(dao.spot.base, dao.baseDecimals)} base ·{" "}
                  {rawToUi(dao.spot.quote, dao.quoteDecimals)} quote
                  {dao.spotPrice !== null && ` · price ≈ ${dao.spotPrice.toPrecision(6)}`}
                </td>
              </tr>
              <tr>
                <td>Pool available</td>
                <td>
                  {dao.poolPhase === "spot"
                    ? "Yes — no proposal live, a launch is possible"
                    : "No — a proposal is live, the pool is split into pass/fail"}
                </td>
              </tr>
              <tr>
                <td>To launch a vote</td>
                <td>
                  {rawToUi(dao.baseToStake, dao.baseDecimals)} tokens to stake, then{" "}
                  {dao.secondsPerProposal / 86400} days of market — of which the first{" "}
                  {dao.twapStartDelaySeconds / 3600} hours do not count toward the TWAP
                </td>
              </tr>
              <tr>
                <td>To pass</td>
                <td>
                  the “pass” price must exceed “fail” by {dao.passThresholdBps / 100} %
                  {dao.teamSponsoredPassThresholdBps !== dao.passThresholdBps &&
                    ` (${dao.teamSponsoredPassThresholdBps / 100} % if team-sponsored)`}
                </td>
              </tr>
              <tr>
                <td>Team address</td>
                <td className="mono">{dao.teamAddress.toBase58()}</td>
              </tr>
            </tbody>
          </table>
        )}
      </section>

      <div className="tabs modes">
        {(
          [
            ["create", "1 · Create"],
            ["stake", "2 · Stake & Launch"],
            ["finalize", "3 · Finalize & Execute"],
          ] as [Mode, string][]
        ).map(([m, label]) => (
          <button key={m} className={mode === m ? "tab on" : "tab"} onClick={() => setMode(m)}>
            {label}
          </button>
        ))}
      </div>

      <div className="next">→ {nextStep}</div>

      {mode === "create" && (
        <section>
          <h2>What the proposal will execute</h2>
          <p className="hint">
            These instructions run as the treasury, not as your wallet.
          </p>
          <div className="tabs">
            {(
              [
                ["spend", "Spend USDC"],
                ["buyback", "Buyback (Jupiter DCA)"],
                ["addLiq", "Add liquidity"],
                ["removeLiq", "Remove liquidity"],
                ["liquidate", "Liquidate project"],
                ["raw", "Raw instruction"],
              ] as [ActionKind, string][]
            ).map(([k, label]) => (
              <button key={k} className={kind === k ? "tab on" : "tab"} onClick={() => setKind(k)}>
                {label}
              </button>
            ))}
          </div>

          {kind === "spend" && (
            <div className="form">
              <input
                placeholder="Recipient (wallet)"
                value={spendTo}
                onChange={(e) => setSpendTo(e.target.value)}
              />
              <input
                placeholder="Amount (UI units)"
                value={spendAmount}
                onChange={(e) => setSpendAmount(e.target.value)}
              />
              <label>
                <input
                  type="checkbox"
                  checked={spendCreateAta}
                  onChange={(e) => setSpendCreateAta(e.target.checked)}
                />
                Create the recipient ATA (rent paid by the treasury)
              </label>
            </div>
          )}

          {kind === "buyback" && (
            <div className="form">
              <input
                placeholder="Total to spend (quote)"
                value={bbTotal}
                onChange={(e) => setBbTotal(e.target.value)}
              />
              <div className="row wrap">
                <input
                  placeholder="Number of orders"
                  value={bbOrders}
                  onChange={(e) => setBbOrders(e.target.value)}
                />
                <input
                  placeholder="Interval (s)"
                  value={bbInterval}
                  onChange={(e) => setBbInterval(e.target.value)}
                />
                <input
                  placeholder="Max price (empty = none)"
                  value={bbMaxPrice}
                  onChange={(e) => setBbMaxPrice(e.target.value)}
                />
              </div>

              {buybackPreview && (
                <table className="kv">
                  <tbody>
                    <tr>
                      <td>Per order</td>
                      <td>{buybackPreview.perCycle}</td>
                    </tr>
                    <tr>
                      <td>Min received / order</td>
                      <td>{buybackPreview.minOut ?? "— (no max price)"}</td>
                    </tr>
                    <tr>
                      <td>Actual cycles</td>
                      <td>
                        {buybackPreview.cycles}
                        {buybackPreview.dust &&
                          ` — including a final one of ${buybackPreview.dust} (division remainder)`}
                      </td>
                    </tr>
                    <tr>
                      <td>Total duration</td>
                      <td>{buybackPreview.duration}</td>
                    </tr>
                    <tr>
                      <td>DCA account</td>
                      <td className="mono">{buybackPreview.dca}</td>
                    </tr>
                  </tbody>
                </table>
              )}
              {buybackError && <p className="hint">⚠️ {buybackError}</p>}

              <p className="hint">
                Recurring Jupiter DCA order paid by the treasury. The “max price” is encoded
                as <span className="mono">minOutAmount</span> per cycle — that is how Ranger
                capped at $0.78. Reproduced byte for byte from Ranger&nbsp;#2
                (2M USDC → RNGR, 8640 orders of 231.481481 every 300s), executed on mainnet.
              </p>
              <p className="hint">
                Bought tokens land in the DCA account. Unspent funds stay there
                until a cancellation proposal — plan for it in the text.
              </p>
            </div>
          )}

          {kind === "addLiq" && (
            <div className="form">
              <input
                placeholder="Quote to deposit"
                value={liqQuote}
                onChange={(e) => setLiqQuote(e.target.value)}
              />
              <input
                placeholder="Max base to deposit"
                value={liqMaxBase}
                onChange={(e) => setLiqMaxBase(e.target.value)}
              />
            </div>
          )}

          {kind === "removeLiq" && (
            <div className="form">
              <input
                placeholder="Liquidity units (empty = all)"
                value={liqToRemove}
                onChange={(e) => setLiqToRemove(e.target.value)}
              />
              <p className="hint">
                Going below 2× min_futarchic_liquidity leaves the DAO unable to launch any
                proposal — and governance cannot undo it.
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
                A liquidation proposal transfers nothing. It is <strong>a single SPL memo,
                zero accounts</strong> — a mandate the market approves or rejects. If it passes,
                MetaDAO runs the distribution through <span className="mono">LiQnow…</span> with its
                own authorities, outside governance. Verified on Ranger (#4, passed) and Superclaw
                (#3, rejected).
              </p>
            </div>
          )}

          {kind === "raw" && (
            <div className="form">
              <textarea
                rows={8}
                placeholder='[{"programId":"…","keys":[{"pubkey":"…","isSigner":false,"isWritable":true}],"data":"base64"}]'
                value={rawJson}
                onChange={(e) => setRawJson(e.target.value)}
              />
              <p className="hint">
                Metaplex metadata, Meteora DAMM withdrawal, liquidation setup, mint
                governor.
              </p>
            </div>
          )}

          <button onClick={addAction} disabled={busy || !dao}>
            Add to proposal
          </button>

          {pending.length > 0 && (
            <>
              <ol className="ixs">
                {pending.map((ix, i) => (
                  <li key={i} className="mono">
                    {describeInstruction(ix)}
                  </li>
                ))}
              </ol>
              <div className="row wrap">
                <button onClick={doCreate} disabled={busy || !dao || !wallet}>
                  Create proposal
                </button>
                <button className="ghost" onClick={() => setPending([])} disabled={busy}>
                  Vider
                </button>
              </div>
            </>
          )}
        </section>
      )}

      {mode === "stake" && (
        <section>
          <h2>Stake &amp; Launch</h2>
          {picker}

          {selected && dao && (
            <>
              {selected.stateName !== "draft" ? (
                <p className="hint">
                  This proposal is no longer in Draft ({STATE_LABEL[selected.stateName]}). Staking
                  and launching only apply to Draft proposals.
                </p>
              ) : (
                <>
                  <div className={stakeMet ? "bar done" : "bar"}>
                    <div style={{ width: `${stakePct}%` }} />
                  </div>
                  <p className="hint">
                    <strong>{rawToUi(staked, dao.baseDecimals)}</strong> staked of{" "}
                    {rawToUi(goal, dao.baseDecimals)} required
                    {stakeMet
                      ? " — threshold reached, the vote can be launched"
                      : ` — ${rawToUi(stakeMissing!, dao.baseDecimals)} short`}
                  </p>
                  <p className="hint">
                    The stake is only locked until launch: it becomes withdrawable 5 seconds
                    after, with no penalty. Any holder can top it up, not just you.
                  </p>

                  <div className="row wrap">
                    <input
                      placeholder="Amount"
                      value={stakeAmount}
                      onChange={(e) => setStakeAmount(e.target.value)}
                    />
                    <button onClick={doStake} disabled={busy || !wallet}>
                      Staker
                    </button>
                    <button className="ghost" onClick={doUnstake} disabled={busy || !wallet}>
                      Unstaker
                    </button>
                    <button className="ghost" onClick={doSponsor} disabled={busy || !wallet}>
                      Sponsor (team)
                    </button>
                  </div>

                  <div className="row wrap">
                    <button onClick={doLaunch} disabled={busy || !wallet || !stakeMet}>
                      Launch vote
                    </button>
                    <button className="ghost" onClick={doRefreshSelected} disabled={busy}>
                      Refresh
                    </button>
                  </div>
                  {!stakeMet && (
                    <p className="hint">
                      Launching stays blocked until the threshold is met (or the proposal is
                      sponsored by team_address). Staking is permissionless — other holders
                      can top it up.
                    </p>
                  )}
                </>
              )}
            </>
          )}
        </section>
      )}

      {mode === "finalize" && (
        <section>
          <h2>Finalize &amp; Execute</h2>
          {picker}

          {selected && (
            <>
              <div className="row wrap">
                <button
                  onClick={doFinalize}
                  disabled={busy || !wallet || selected.stateName !== "pending"}
                >
                  Finaliser
                </button>
                <button
                  onClick={doExecute}
                  disabled={busy || !wallet || selected.stateName !== "passed"}
                >
                  Execute vault tx
                </button>
                <button className="ghost" onClick={doRefreshSelected} disabled={busy}>
                  Refresh
                </button>
              </div>
              <p className="hint">
                Finalizing is only possible in the <em>Live</em> state once the duration has elapsed.
                Execution is a separate transaction — the Solana runtime forbids
                futarchy&nbsp;→&nbsp;squads&nbsp;→&nbsp;futarchy in one stack.
              </p>
            </>
          )}
        </section>
      )}

      <section>
        <h2>Log</h2>
        <pre className="log">{log.join("\n") || "—"}</pre>
        <p className="hint mono">RPC : {endpoint}</p>
      </section>
    </div>
  );
}
