# MetaDAO Proposal Builder

A local front-end for creating and driving proposals on any MetaDAO futarchy DAO
(program `FUTARELBfJfQ8RDGhg1wdhddq1odMAJUePHFuBYfUxKq`, v0.6).

> **This app signs real mainnet transactions.** It is unaudited, was built to solve a
> specific problem, and moves DAO treasury funds. Read what an instruction does before
> you sign it. Rehearse on devnet first.

```bash
npm install
npm run dev
```

Then open http://localhost:5173.

## DAO picker

Lists **every futarchy DAO on the cluster** (84 on mainnet at the time of writing), with
names and symbols from Metaplex metadata, sorted by proposal count. Filter by name,
symbol or address; pasting an address by hand still works.

The list comes from `getProgramAccounts` on the futarchy program, **which most public
RPCs refuse**. A snapshot ships with the app (`src/daos.snapshot.json`) so the picker
works on first load, and it switches to live data as soon as the RPC allows it. A banner
tells you which source you are looking at.

Regenerate the snapshot:

```bash
node scripts/snapshot-daos.mjs
RPC=https://mainnet.helius-rpc.com/?api-key=… node scripts/snapshot-daos.mjs
```

## Three modes

**1 · Create** — compose the instructions, then create the proposal (Draft state).
**2 · Stake & Launch** — works on **any** existing proposal, not just the one created in
this session: it lists the DAO's proposals automatically, or takes a pasted address.
Stake, unstake, sponsor, launch.
**3 · Finalize & Execute** — same picker, then finalization and vault-transaction
execution.

Discovery does not use `getProgramAccounts` (public RPCs throttle or refuse it). Since
every futarchy proposal is a PDA of a Squads proposal, itself a PDA of
(multisig, transactionIndex), the app walks `1..multisig.transactionIndex` and derives
everything. That also yields the `transactionIndex`, which the `Proposal` account does
not store although `vaultTransactionExecute` needs it. Falls back to sequential
`getAccountInfo` when the RPC blocks `getMultipleAccounts`.

## What a proposal can do

The full lifecycle, in the order the program enforces:

1. **Load a DAO** — parameters, spot pool reserves, price, and whether a launch is
   currently possible.
2. **Compose the instructions** the treasury will execute if the proposal passes:
   spend USDC, buyback via Jupiter DCA, add or remove liquidity, liquidation mandate,
   DAO parameter changes, or a raw JSON instruction.
3. **Create** — Squads vault transaction and proposal, then the binary question, both
   conditional vaults and the futarchy proposal. Result: `Draft`.
4. **Stake** up to `base_to_stake` (or sponsor if you hold `team_address`).
5. **Launch** — splits the spot reserves in half and starts the clock.
6. **Finalize** after `seconds_per_proposal`, then **execute** the vault transaction as
   a separate transaction (the Solana runtime forbids futarchy → squads → futarchy).

## Implementation notes worth knowing

**The vault transaction is built by hand.** The SDK's `squadsProposalCreateTx` sets the
inner message's `payerKey` to the proposer's wallet, while the program's own tests use
`payerKey = vaultPda`. Since the vault is what signs at execution time, this app follows
the tested path — see `src/lib/flow.ts`.

**`withdrawLiquidityIx` is missing from the published SDK** (0.1.1-alpha.0). The
instruction is built directly from the Anchor program in `src/lib/actions.ts`.

**Liquidity withdrawal passes `min_base = min_quote = 0`.** Reserves move during the
3-day vote; a tight bound would make execution fail on `SwapSlippageExceeded`. This is a
deliberate trade-off, not an oversight.

**The buyback reproduces Ranger #2 byte for byte** — 2M USDC → RNGR, 8640 orders of
231.481481 every 300s, max price $0.78. The Jupiter DCA instruction list, account flags,
argument layout and every PDA were reverse-engineered from that executed mainnet
transaction. Note that the "max price" does not exist in Jupiter's interface: it is
encoded as `minOutAmount` per cycle, i.e. `inAmountPerCycle / maxPrice`.

**A liquidation proposal is a memo, not a transfer.** Both real ones on mainnet are a
single SPL memo with zero accounts — the market votes a mandate, and MetaDAO then runs
the `liquidation` program (`LiQnow…`) with its own authorities. Verified on-chain:
Ranger #4 (passed) and Superclaw #3 (rejected).

**The creation transaction caps at 1232 bytes.** It carries the whole serialized inner
message, so a long memo overflows it. The app checks the size up front and says so
instead of surfacing a raw web3.js error.

**A proposal has no title or description on-chain — the question is not the title.**
Verified two ways. The futarchy `Proposal` account has 16 fields and not one string; the
Squads `VaultTransaction` account does not persist the `memo` its instruction accepts.
And the conditional-vault question stores only a 32-byte hash, whose preimage is built
from the proposal's own address: for all **129** proposals on mainnet, without a single
exception,

```
question_id == sha256("Will <proposalAddress> pass?/FAIL/PASS")
```

including proposals that display rich titles. The title and body live in MetaDAO's own
database (their page payload carries `title` and `content` next to `status` and
`totalVolume`) and are filled in through their signed-in interface. A proposal created
on-chain from outside that interface has no row there and renders as *untitled*; only
MetaDAO can add one. The nearest on-chain equivalent this app offers is an SPL memo
instruction carrying a title and a link — visible under Instructions, and what the Basket
proposal uses.

**Shortening the vote is two parameters, not one.** `updateDao` is signed by the
treasury vault, so a DAO can only change its own rules by winning a vote at the current
length. And the program rejects a duration that is not strictly longer than 1 day *and*
strictly longer than twice `twapStartDelaySeconds` (error 6011). Every DAO on mainnet
ships with a 24h TWAP delay, which puts the floor at 172801s — 48h plus one second, and
exactly where three DAOs sit today, which is what proves the bound is strict. So a 24h
vote means lowering the delay under 12h in the same instruction. The Parameters tab takes both values in seconds — the unit the program stores, and the
unit the bounds land on (43,217s, not "12h") — echoes each back in hours, and enforces
both bounds before the instruction is queued.

**The raw-instruction tab** covers everything the forms do not: Metaplex metadata,
Meteora DAMM withdrawals, liquidation setup, mint governor, Omnipair.

## RPC, and keeping the endpoint secret

There is no network picker. The app always calls `/api/rpc`, and a proxy on the server
side holds the real endpoint — so the URL, and any API key in it, never reaches the
browser. The cluster is detected from the genesis hash and shown in the top bar, so you
never declare it yourself.

Two implementations sit behind that one path:

| | reads | set it with |
|---|---|---|
| `npm run dev` | `RPC_URL` from `.env.local`, proxied by `vite.config.ts` | `cp .env.example .env.local` |
| Cloudflare Pages | the `RPC_URL` secret, proxied by `functions/api/rpc.ts` | `npx wrangler pages secret put RPC_URL` |

**`RPC_URL` deliberately has no `VITE_` prefix.** Prefixed variables are inlined into
the JavaScript bundle and readable by anyone; unprefixed ones stay in the dev server.
And **never put the key in `wrangler.toml`** — that file is committed.

The Cloudflare function refuses cross-origin requests and only forwards the RPC methods
the app actually uses, so a public deployment cannot become an open relay burning your
quota.

If `RPC_URL` is missing, the app says so in a banner instead of failing silently. For
quick testing without a key, `https://solana-rpc.publicnode.com` works but blocks
`getProgramAccounts` and `getMultipleAccounts`.

## Deploying to Cloudflare Pages

The app is a static Vite SPA, plus one Pages Function that proxies RPC calls.

| Setting | Value |
|---|---|
| Build command | `npm run build` |
| Build output directory | `dist` |
| Root directory | leave empty — this folder is the repository root |
| Node version | set `NODE_VERSION` to `20` or later; the default is older than Vite 6 accepts |
| Secret | `RPC_URL`, on Production *and* Preview |

`functions/` is picked up automatically by Pages; no extra configuration is needed.

Or from the CLI:

```bash
npm run build
npx wrangler pages deploy dist
```

There is no client-side router, so no `_redirects` file is needed.

One thing to know before you publish it: the bundle includes `PERMISSIONLESS_ACCOUNT` from the MetaDAO SDK,
a keypair whose private key is public by design (it is what makes proposal creation
permissionless); that is expected, but it does mean a real keypair ships in the
JavaScript.

## Scripts

Generic tools, usable on any DAO or proposal:

```bash
node scripts/decode-proposal.mjs <proposalAddress>   # decode a proposal's vault transaction
node scripts/snapshot-daos.mjs                       # regenerate the bundled DAO list
node scripts/survey-proposals.mjs                    # decode every proposal on every DAO
node scripts/rank-activity.mjs count                 # transactions per proposal, real projects only
node scripts/rank-activity.mjs detail 12             # exact conditional_swap count for the quietest
```

`scripts/activity.json` and `activity-detail.json` rank proposals by market activity.
Trades are counted on-chain (`conditional_swap` instructions, which carry the proposal in
their accounts); volume is better taken from MetaDAO's own `performanceStats.totalVolume`,
since reconstructing it from token-balance deltas does not reproduce their definition.
Test DAOs are excluded by name, and Crimera by the fact that metadao.fi 404s on it.

`scripts/survey.json` is the output of the last survey: 130 proposals across 22 DAOs,
with each one's instructions classified by program. Useful as a reference for what
proposals actually do in practice.

`examples/` holds the one-off scripts written for a specific Basket proposal — building
its instructions, sizing the transaction, and verifying on-chain that the created
proposal matches intent. They are hardcoded to that proposal and are meant as worked
examples, not tools.

## Verification status

| | |
|---|---|
| Typecheck and production build | ✅ |
| Loading and decoding a DAO, listing proposals | ✅ tested on mainnet |
| Create / stake / launch / finalize / execute | ⚠️ create tested on mainnet; the rest **not executed** |

Devnet runs futarchy **v0.6.0** (mainnet is v0.6.1). Verified identical there:
`initializeProposal`, `stakeToProposal`, `launchProposal`, `finalizeProposal`,
`provideLiquidity`, `withdrawLiquidity`. Only **`sponsorProposal` is absent from
devnet** — that button will fail there.
