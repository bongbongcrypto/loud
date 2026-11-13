# LOUD — specification

Single source of truth. The Rust contract, `web/engine.js`, the simulations and the README must match this file. If code and this file disagree, fix one of them and say which.

## 1. What it is

LOUD is an NEP-141 memecoin with one mechanic: **early supply can leave, but it cannot leave quietly or all at once.**

- Tokens bought during the launch window, and the creator allocation, are **loud**. Everything else is **quiet**.
- The tag belongs to the tokens, not to the wallet. Moving loud tokens to another account moves the tag with them.
- Loud tokens have exactly one way out: **shout** (public notice, tokens escrowed) → wait the notice period → **leave** (sell into the built-in pool), and all leaves together share **one global cap** (a refill bucket owned by the token).
- Tokens sold through that door become quiet. Anyone who buys from the pool after the launch window gets quiet tokens, so ordinary buyers never inherit a tag from the pool.
- The contract never decides who is an insider. It only knows when a token left the pool.

Claim (use this wording everywhere): *LOUD limits how fast early supply can be sold on its defined path, no matter how many wallets it is split across.* It does not prevent fraud. Limits are in section 9.

## 2. Units

- Token: `LOUD`, 18 decimals. Amounts are `u128` in the smallest unit ("units"). JSON uses decimal strings (`U128`).
- NEAR amounts are yoctoNEAR (`1 NEAR = 10^24`), `u128`, JSON decimal strings.
- Time is `env::block_timestamp()` in nanoseconds, `u64`. JSON uses decimal strings (`U64`).
- All divisions round down unless stated. `mul_div(a, b, c) = floor(a*b/c)` computed with a 256-bit intermediate; it panics on `c == 0` or if the result does not fit `u128`.

## 3. Parameters (fixed in `new`, no setter, readable by anyone)

| Name | Type | Meaning | Bounds checked in `new` |
|---|---|---|---|
| `total_supply` | u128 | fixed supply, minted once | `10^24 ..= 10^30` units (1M to 1T whole tokens) |
| `creator` | AccountId | receives the creator allocation as loud | any valid account |
| `creator_alloc_bps` | u16 | creator allocation, share of supply | `0 ..= 2000` |
| `virtual_near` | u128 | virtual NEAR reserve of the pool | `10^23 ..= 10^30` |
| `loud_window_ns` | u64 | buys within this time after launch are loud | `60e9 ..= 7 days` |
| `notice_ns` | u64 | wait between shout and the first possible leave | `30e9 ..= 7 days` |
| `exit_window_ns` | u64 | how long a shout stays usable after notice ends | `60e9 ..= 7 days` |
| `cap_bps` | u16 | loud tokens that may leave per cap window, share of supply | `1 ..= 1000` |
| `cap_window_ns` | u64 | refill time of the cap | `60e9 ..= 7 days` |

Derived at launch: `launch_ts = block_timestamp`, `loud_until = launch_ts + loud_window_ns`, `cap_units = total_supply * cap_bps / 10000`.

Presets (documented, not enforced). "cap X per W" means: the bucket holds at most X and refills X per W. Any single span of W lets out at most the room already in the bucket plus X (so at most 2X); the long-run rate is X per W.

| Preset | supply | creator | virtual NEAR | loud window | notice | exit window | cap |
|---|---|---|---|---|---|---|---|
| `standard` | 1,000,000,000 | 5% | 100 NEAR | 10 min | 30 min | 60 min | 0.5% per 60 min |
| `demo` (testnet proof run) | 1,000,000,000 | 5% | 5 NEAR | 2 min | 1 min | 10 min | 0.5% per 10 min |

## 4. State

```
total_supply, creator, params...           immutable
pool_tokens: u128        tokens held by the pool (all quiet inventory)
pool_near: u128          real NEAR held by the pool
loud: map AccountId -> u128
quiet: map AccountId -> u128
loud_outstanding: u128   sum of loud balances + escrowed loud in open exits
escrowed: u128           loud currently escrowed in open exits
bucket_units: u128       cap bucket level at bucket_ts
bucket_ts: u64
exits: map u64 -> Exit   open exits only (iterable)
next_exit_id: u64        starts at 1
stats: total_shouted, total_left, shout_count, leave_count (u128/u64)
```

`Exit { id, owner, amount, remaining, shouted_at, ready_at, expires_at }`

At `new`: `creator_alloc = total_supply * creator_alloc_bps / 10000`; `loud[creator] = creator_alloc`; `pool_tokens = total_supply - creator_alloc`; `pool_near = 0`; `loud_outstanding = creator_alloc`; `bucket_units = 0` (the bucket starts empty); `bucket_ts = launch_ts`.

Invariants (tested):
1. `pool_tokens + sum(loud) + sum(quiet) + escrowed == total_supply`
2. `loud_outstanding == sum(loud) + escrowed`
3. `loud_outstanding` never increases after `loud_until`.
4. For any interval `[t0, t1]`, loud units leaving the contract path `<= bucket(t0) + cap_units * (t1 - t0) / cap_window_ns`, whatever the number of accounts.
5. The contract's NEAR balance always covers `pool_near`.

## 5. Pool math (constant product with a virtual NEAR reserve)

Let `R = virtual_near + pool_near`, `T = pool_tokens`.

- Buy with `n` yoctoNEAR: `out = mul_div(T, n, R + n)`. Then `pool_near += n`, `pool_tokens -= out`. Requires `out > 0` and `out < T`.
- Sell `x` units: `near_out = mul_div(R, x, T + x)`. Requires `near_out > 0` (else `E_AMOUNT`) and `near_out <= pool_near` (else `E_POOL_EMPTY`). Every sale of up to `max_sell = mul_div(pool_near, T, virtual_near)` units is payable. Then `pool_near -= near_out`, `pool_tokens += x`.
- Spot price for display: `R / T` (yoctoNEAR per unit).
- No fee.

## 6. Cap bucket

```
refill(now):
  if now > bucket_ts:
    add = mul_div(cap_units, now - bucket_ts, cap_window_ns)   // saturating
    bucket_units = min(cap_units, bucket_units + add)
    bucket_ts = now
available(now) = min(cap_units, bucket_units + mul_div(cap_units, now - bucket_ts, cap_window_ns))
```

To avoid losing fractions on frequent calls, `refill` only advances `bucket_ts` when `add > 0`.

## 7. Methods

Errors are panics whose message starts with the code in brackets, for example `E_NOTICE: ...`. Codes are listed per method. Every state-changing method refills the bucket first.

### Init
- `new(total_supply, creator, creator_alloc_bps, virtual_near, loud_window_ns, notice_ns, exit_window_ns, cap_bps, cap_window_ns, name, symbol, icon?)` — `#[init]`, callable once (`E_INIT`), validates bounds (`E_PARAMS`). Emits NEP-141 `ft_mint` for the creator allocation (if > 0) and for the pool inventory (owner = contract account).

### Trading
- `buy(min_tokens_out: U128) -> U128` — payable, attached NEAR `n >= 10^21` (`E_DEPOSIT`). `out` per section 5; `out >= min_tokens_out` (`E_SLIPPAGE`). If `now < loud_until`: `loud[caller] += out`, `loud_outstanding += out`; else `quiet[caller] += out`. Event `buy { account, near_in, tokens_out, loud: bool }` and NEP-141 `ft_transfer` from the contract account.
- `sell(amount: U128, min_near_out: U128) -> Promise/U128` — requires exactly 1 yoctoNEAR attached (`E_YOCTO`). Uses **quiet only**: `amount <= quiet[caller]` (`E_NO_QUIET`; the message states the caller's loud and quiet balances and says loud must use shout/leave). `near_out` per section 5, `>= min_near_out` (`E_SLIPPAGE`). Transfers NEAR to the caller. Event `sell`.

### The door for loud tokens
- `shout(amount: U128) -> U64` — 1 yocto. `0 < amount <= loud[caller]` (`E_NO_LOUD`). `amount >= total_supply / 1_000_000` (`E_DUST`, keeps the board readable). Moves `amount` from `loud[caller]` to escrow. Creates `Exit` with `ready_at = now + notice_ns`, `expires_at = ready_at + exit_window_ns`. At most 8 open exits per account (`E_TOO_MANY`). Event `shout { id, account, amount, ready_at, expires_at }`. Returns the id.
- `leave(exit_id: U64, min_near_out: U128) -> U128 (units filled)` — 1 yocto. Caller is the exit owner (`E_NOT_OWNER`). `ready_at <= now` (`E_NOTICE`, message states seconds left). `now <= expires_at` (`E_EXPIRED`). `fill = min(exit.remaining, available(now))`, `fill > 0` (`E_CAP`, message states when room returns). If the pool cannot pay for `fill` (section 5), `fill = min(fill, max_sell)`, and `E_POOL_EMPTY` if that is 0; the rest stays in the exit. `near_out` per section 5 for `fill` (`E_AMOUNT` if it rounds to 0: retry with more room, or `hush` a remainder that small); `near_out >= min_near_out * fill / exit.remaining_before` is NOT applied — `min_near_out` is the minimum for the units actually filled (`E_SLIPPAGE`). Effects: `bucket_units -= fill`, `escrowed -= fill`, `loud_outstanding -= fill`, `exit.remaining -= fill`, pool sell per section 5, NEAR to the owner. If `remaining == 0` the exit is removed. Event `leave { id, account, filled, remaining, near_out }`.
- `hush(exit_id: U64)` — 1 yocto. The owner may call any time; anyone may call after `expires_at`. Returns `remaining` to `loud[owner]` (still loud), removes the exit, `escrowed -= remaining`. Event `hush`.

### NEP-141
- `ft_transfer(receiver_id, amount, memo?)` — 1 yocto. Sender ≠ receiver. Takes **quiet first, then loud** from the sender; the receiver gets the same split (loud stays loud). `E_BALANCE` if `amount > loud + quiet`. Event: NEP-141 `ft_transfer`, plus `tag_move { from, to, loud_amount }` when `loud_amount > 0`.
- `transfer_loud(receiver_id, amount)` — 1 yocto. Moves loud explicitly (for OTC). `E_NO_LOUD`.
- `ft_transfer_call(receiver_id, amount, memo?, msg)` — 1 yocto. **Quiet only** (`E_QUIET_DOOR`: loud tokens cannot go into other contracts through `ft_transfer_call`). Standard `ft_on_transfer` + `ft_resolve_transfer`; refunds go back as quiet. Gas: 30 Tgas for `ft_on_transfer`, 10 Tgas for resolve.
- `ft_total_supply`, `ft_balance_of` (= loud + quiet), `ft_metadata` (spec `ft-1.0.0`, decimals 18).
- Storage management (NEP-145), minimal so wallets work: `storage_balance_bounds` returns min = max = 0.00125 NEAR; `storage_deposit` registers nothing and refunds the full deposit; `storage_balance_of` returns `{ total: bounds.min, available: "0" }` for every account. Accounts are created implicitly; the contract pays storage. This is a stated testnet simplification (section 9).

### Views
- `get_params() -> Params` (all of section 3 plus `launch_ts`, `loud_until`, `cap_units`, `creator_alloc`).
- `get_state() -> State { pool_tokens, pool_near, loud_outstanding, escrowed, cap_available, cap_units, next_room_ts, cap_full_ts, open_exits, total_shouted, total_left, shout_count, leave_count, now, is_loud_window }` — `cap_available` computed for the current block time; `next_room_ts` is the earliest time with at least one unit of room, `cap_full_ts` the time the bucket is full again if nobody leaves.
- `get_account(account_id) -> { loud, quiet, exits: [Exit] }`
- `get_exits(from_index: u32, limit: u32) -> [Exit]` (`limit <= 100`; reads at most 100 exits per call. With up to 100 open exits they are ordered by id before paging. With more, pages follow storage order, each page is ordered by id, and a reader collects all pages and sorts by id).
- `quote_buy(near: U128) -> U128`, `quote_sell(amount: U128) -> U128`.

### Events
NEP-297, `standard: "loud"`, `version: "1.0.0"`, events `buy`, `sell`, `shout`, `leave`, `hush`, `tag_move`. NEP-141 events use `standard: "nep141"`.

### No admin
No owner, no pause, no upgrade method, no parameter setter. The token account is created, funded, deployed and initialised in one batch transaction that never adds an access key, so the account has zero keys from its first block.

## 8. What the judge should be able to check

1. **Split test (unit test and on-chain proof).** One account holds `X` loud units. Scenario A: it shouts and leaves alone. Scenario B: it first splits `X` across `N` accounts (N = 100 in the unit test, 20 on testnet) and every account shouts and leaves as fast as allowed. In both, total loud units sold in any cap window `<= available(window start) + cap_units` (invariant 4; never more than `2 * cap_units`, and `cap_units` per window on average), and A == B within one unit of rounding per account. On testnet the proof runs scenario B only (N = 20) and checks the total against the invariant 4 bound, which does not depend on the number of accounts; the cap is global per token, so A cannot run on the same token in the same window. A == B is checked in the contract unit test (N = 100) and in the engine tests (`web/engine.test.mjs`, 1 vs 100 wallets).
2. **Tag follows the tokens.** After splitting, every receiving account shows a loud balance and `sell` fails with `E_NO_QUIET`.
3. **Pool buyers stay clean.** An account that buys after `loud_until` holds only quiet and can sell immediately.
4. **Comparison baselines in the simulator** (not on chain): `naive` (no rule) and `per_wallet` (max sell 0.5% of supply per transaction, 60 s cooldown per wallet, the common anti-dump design). With 1 wallet vs 100 wallets: `naive` dumps everything at once in both, `per_wallet` lets 100 wallets sell 100x faster, `loud` is identical for 1 and 100.
5. **Zero keys.** `view_access_key_list` on the token account returns an empty list.

## 9. Limits (stated plainly, also in the README)

- **Wrappers and off-pool deals.** Someone can send loud tokens to a custom contract with plain `ft_transfer` and trade claims on them, sell the account itself, or sell OTC. The tag still follows the tokens: whoever ends up with them holds loud tokens and faces the same door. LOUD limits the pool exit, not side deals.
- **Other pools.** Loud tokens cannot enter other contracts through `ft_transfer_call`, so standard DEX deposits reject them. Quiet tokens can trade anywhere.
- **First come, first served.** Ready exits share the cap in the order their `leave` calls land. A large holder can take a whole window's room. Splitting gives no extra room, but it does not give others priority either.
- **Early honest buyers are loud too.** Anyone who buys in the launch window accepts the door. The page says so before the buy.
- **Notice can trigger a rush.** Quiet holders can sell before a shouted exit becomes ready. That is the intended information, and it can also accelerate a sell-off.
- **No identity.** The contract does not know who is an insider and does not try to.
- **The creator allocation is unbacked.** It is minted without a NEAR payment, so every NEAR it receives through the door comes from buyers. After the creator has left, the pool cannot pay the formula price to all remaining holders: the last sellers get less, down to nothing, by up to the creator's proceeds. `sell` and `leave` pay out only what the pool holds.
- **Testnet simplifications.** The contract pays account storage: every new balance entry locks about 0.00125 NEAR of the token account's balance, and that balance also holds `pool_near`. Dust transfers to fresh accounts can therefore use up the spare balance and make `sell`/`leave` payouts fail until anyone sends NEAR to the token account. The deploy leaves a reserve for this, and it is not a defence on mainnet. The code is unaudited, there is no fee and no liquidity migration.
- **Sybil resistance.** The cap is global, so more accounts never mean more exit room. That is the whole sybil defence; there is no per-person fairness.
