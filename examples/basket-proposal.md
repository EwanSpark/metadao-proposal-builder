# Redeploy 25% of the futarchy AMM liquidity to Omnipair

**Type** — Operations direct action
**Author** — Spark
**DAO** — Basket (`GEZF81Us2ZMD9cozjEra6NXxi1tC2AdjvZXxKWcdVEgm`)

## 1. Summary

If this proposal passes, 25% of the liquidity position held by the treasury in the
futarchy AMM will be withdrawn and transferred to
`AtovZb5xYptRJghNJbuXo3Uku4Tvn6cxccGgtU9MsWys`, to be deposited on Omnipair
(`omnixgS8fnqHfCcTGKWj6JtKjzpJZ1Y5y9pyFkQDkYE`) to open a BASKET/USDC pair.

**The LP tokens issued by Omnipair will be returned to the DAO treasury in full.**
Spark keeps none of them: Spark performs the deposit, the DAO owns the position.

25% of the position is withdrawn; **479,000 BASKET + 382 USDC** — roughly 21% of the
pool — is transferred to the recipient. The remainder, about 67,000 BASKET and
76 USDC at current reserves, stays in the treasury as a margin: what a 25%
withdrawal returns in tokens depends on the pool reserves at execution time, and a
fixed transfer amount has to sit below the worst case or the transaction fails.

Pool at the time of writing: 2,185,661 BASKET / 1,830.11 USDC.

## 2. Motivation

**Fees would accrue to the Basket DAO instead of MetaDAO.** In the futarchy AMM,
`LP_TAKER_FEE_BPS = 0` and `PROTOCOL_TAKER_FEE_BPS = 50`: the entire 0.5% taker fee
on every swap goes to MetaDAO, and the DAO receives nothing. The DAO's
position is dead capital whose only function is to seed decision markets.

On Omnipair the split is the opposite, and it is readable on-chain in the protocol's
`FutarchyAuthority` account (`2SMS1Y4EAyL2dQLpXD6VJCrNbQJ2eQ2pN3qYcX1vim3E`):
`swap_bps = 1000` and `interest_bps = 1500`. Liquidity providers keep **90% of swap
fees and 85% of interest**; the remainder goes to Omnipair's own treasury. Since the
LP tokens are returned to the Basket treasury, that revenue accrues to the DAO.

**Leverage becomes available.** Omnipair is a lending market as well as an AMM, so
BASKET becomes usable as collateral — borrowable against and lendable. The futarchy
AMM cannot do this at all. This opens leveraged positions on BASKET, and gives the
token a use beyond spot trading.

Neither change costs the treasury any of its 8,000 USDC.

## 3. Why the funds have to leave the treasury

Omnipair rejects any deposit coming from a program-controlled account. Its
`add_liquidity` instruction opens with:

```rust
require_top_level_liquidity_delta_ix(pair, instructions_sysvar, AddLiquidity)
```

which loads the **top-level** instruction currently executing and requires it to
belong to Omnipair (`programs/omnipair/src/utils/liquidity_delta_circuit_breaker.rs`).
A Squads treasury is a PDA: it can only act through a CPI, so the top-level
instruction always belongs to Squads. The deposit fails with
`LiquidityDeltaCircuitBreakerCpi`.

The deposit must be signed by a key, so the funds must pass through a wallet.

## 4. Specification

| | |
|---|---|
| Liquidity withdrawn | 500,000,000,000,000,000 units (25% of 2 × 10¹⁸) |
| Recipient | `AtovZb5xYptRJghNJbuXo3Uku4Tvn6cxccGgtU9MsWys` |
| Custody | Hardware Ledger, held by Spark |
| BASKET transferred | 479,000 |
| USDC transferred | 382 |

The transfer amounts are fixed in the instruction data, while what the withdrawal
returns depends on the pool reserves at execution time — 72 hours or more after this
is written. They are therefore sized to a **±30% price move**: 479,000 BASKET is what
a 25% withdrawal still returns if BASKET appreciates 30% during the vote, and 382 USDC
is what it returns if BASKET falls 30%. Beyond that band on the BASKET side, the
transaction fails without executing, and the Squads transaction can be retried once
reserves allow.

Whatever the withdrawal returns beyond the transferred amounts stays in the treasury —
about 67,000 BASKET and 76 USDC if the price does not move.

## 5. Process

1. `withdrawLiquidity` — 25% of the position, into the treasury's token accounts
2. `transferChecked` — 479,000 BASKET to the recipient address
3. `transferChecked` — 382 USDC to the recipient address

All three instructions sit in a single transaction. The withdrawal is
proportional, so it does not move the pool price.

## 6. Omnipair pair parameters

The pair will be created with the parameters below.

| Setting | Value | On-chain argument |
|---|---|---|
| Swap fee | 0.5% | `swap_fee_bps = 50` |
| Oracle EMA half-life | 10 min (~56 min to converge) | `half_life = 600000` |
| LTV mode | Dynamic (auto) | `fixed_cf_bps = None` |
| Target utilization | 30% – 50% | `target_util_start_bps = 3000`, `target_util_end_bps = 5000` |
| Floor rate | 1% | `min_rate_bps = 100` |
| Initial rate | 2% | `initial_rate_bps = 200` |
| Max rate | uncapped | `max_rate_bps = 0` |
| Rate adjustment half-life | 24h | `rate_half_life_ms = 86400000` |

These match Omnipair's recommended defaults for the rate model, with the rate
adjustment half-life set to 24 hours rather than the program's built-in 3 days, so
borrow rates track utilization more responsively on a young market.

## 7. Commitments

**One week maximum** after this proposal executes, Spark will:

1. create the BASKET/USDC pair on Omnipair, with the parameters above, and deposit
   the funds;
2. publish the pair address;
3. **transfer all LP tokens to the DAO treasury**
   (`ASBU3bH5EhBjC17CLWfMG8txwQSoSgrooz9CFQJzUEAB`).

If the pair is not created within that window, Spark returns the funds to the
treasury without waiting for a proposal.

## 8. How the DAO gets its liquidity back

Worth knowing before you vote: `remove_liquidity` carries **the same top-level
guard** as `add_liquidity`. The treasury will hold the LP tokens, but being a PDA it
cannot call `remove_liquidity` itself.

Exiting therefore takes two steps, and stays entirely under DAO control:

1. a proposal transfers the LP tokens from the treasury to a key-based wallet;
2. that wallet calls `remove_liquidity` and returns the funds to the treasury.

No step depends on Spark. Holding the LP tokens gives the DAO full ownership of the
position; only the execution runs through a wallet, exactly as the deposit does.

## 9. What this proposal costs the DAO

The futarchy pool goes from 1,830 to 1,372 USDC. Since each decision market is
seeded with half the spot reserves, market depth drops from ~915 to ~686 USDC.
Future Basket proposals become correspondingly cheaper to influence.

The treasury keeps its 8,000 USDC untouched; only the liquidity position is reduced.

## 10. Recipient address verification

Transaction signed by `AtovZb5xYptRJghNJbuXo3Uku4Tvn6cxccGgtU9MsWys`, proving Spark
holds the key (7 August 2026):

```
36F93mDEXF41TWESRDaX9wePVBVERY7DvQjoHYmjHqBXEz45gnXTgZY9aJ5s51hyB2bhpytjfi8RoXn39oRSoruN
```
