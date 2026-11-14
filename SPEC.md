# LOUD specification

The rules, names and numbers of LOUD. The Rust contract, `web/engine.js`, the simulations and the README follow this file.

## 1. What it is

LOUD is an NEP-141 memecoin with one mechanic: **early supply can be sold into the built-in pool only after a public notice, and all such sales together draw from one shared bucket.** The guarantee is advance notice plus that one bound on the built-in sale path. It is not a promise that every position leaves slowly: a position no larger than the room in the bucket can leave in one call once its notice has ended.

- Tokens bought during the launch window, and the creator allocation, are **loud**. Everything else is **quiet**.
- The tag belongs to the tokens, not to the wallet. Moving loud tokens to another account moves the tag with them.
- Loud tokens have exactly one way into the pool: **shout** (public notice, tokens escrowed), wait out the notice period, then **leave** (sell into the built-in pool), and all leaves together share **one global cap** (a refill bucket owned by the token). A shout is binding: the tokens stay in escrow until they are sold, caught by another account (`catch`, section 7), or until `hush` returns them after the exit has expired.
- Tokens sold through that door go back into the pool. Anyone who buys from the pool after the launch window gets quiet tokens, so ordinary buyers never inherit a tag from the pool. A purchase during the launch window is always loud: in a preset where an exit can become ready inside the launch window (notice shorter than the launch window, as in `demo`), tokens that left through the door are loud again when bought in that window.
- The contract never decides who is an insider. It only tags launch-window buys. The creator allocation is loud from the start.

The claim, in the same words everywhere: *LOUD limits how fast early supply can be sold on its defined path, no matter how many wallets it is split across.* The defined path is shout, notice and leave into the built-in pool. Tokens sold on it and bought back after the launch window are quiet and off the path. It does not prevent fraud. Limits are in section 9.

## 2. Units

- Token: `LOUD`, 18 decimals. Amounts are `u128` in the smallest unit ("units"). JSON uses decimal strings (`U128`).
- NEAR amounts are yoctoNEAR (`1 NEAR = 10^24`), `u128`, JSON decimal strings.
- Time is `env::block_timestamp()` in nanoseconds, `u64`. JSON uses decimal strings (`U64`).
- All divisions round down unless stated. `mul_div(a, b, c) = floor(a*b/c)` computed with a 256-bit intermediate; it panics on `c == 0` or if the result does not fit `u128`.

## 3. Parameters (fixed in `new`, no setter, readable by anyone)

| Name | Type | Meaning | Bounds checked in `new` |
|---|---|---|---|
| `total_supply` | u128 | fixed supply, minted once | `10^24 ..= 10^30` units (1M to 1T whole tokens) |
| `creator` | AccountId | receives the creator allocation as loud | any valid account except the token account itself |
| `creator_alloc_bps` | u16 | creator allocation, share of supply | `0 ..= 2000` |
| `virtual_near` | u128 | virtual NEAR reserve of the pool | `10^23 ..= 10^30` |
| `loud_window_ns` | u64 | buys within this time after launch are loud | `60e9 ..= 7 days` |
| `notice_ns` | u64 | wait between shout and the first possible leave | `30e9 ..= 7 days` |
| `exit_window_ns` | u64 | how long a shout stays usable after notice ends | `60e9 ..= 7 days` |
| `cap_bps` | u16 | loud tokens that may leave per cap window, share of supply | `1 ..= 1000` |
| `cap_window_ns` | u64 | refill time of the cap | `60e9 ..= 7 days` |

Derived at launch: `launch_ts = block_timestamp`, `loud_until = launch_ts + loud_window_ns`, `cap_units = total_supply * cap_bps / 10000`.

`new` also takes the metadata `name` (at most 64 bytes), `symbol` (at most 16 bytes) and an optional `icon` (at most 2048 bytes). A longer value fails with `E_PARAMS`. The caps keep the contract state small, because every call reads it, the fixed-gas callbacks included.

One constant is compiled in and is the same for every token: `STORAGE_MIN_YOCTO = 30_000_000_000_000_000_000_000` (0.03 NEAR), the one-time storage payment of an account (section 7, Storage registration).

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
stats: total_shouted, total_left, total_caught, shout_count, leave_count, catch_count (u128/u64, saturating adds)
owed: map AccountId -> u128   yoctoNEAR of failed payouts, per account
owed_total: u128         sum of owed; not part of pool_near
registered: set of AccountId   accounts whose storage is paid
```

`Exit { id, owner, amount, remaining, shouted_at, ready_at, expires_at, shout_quote }`

At `new`: `creator_alloc = total_supply * creator_alloc_bps / 10000`; `loud[creator] = creator_alloc`; `pool_tokens = total_supply - creator_alloc`; `pool_near = 0`; `loud_outstanding = creator_alloc`; `bucket_units = 0` (the bucket starts empty); `bucket_ts = launch_ts`; `owed` is empty and `owed_total = 0`; `registered = { creator }`. The creator pays no storage: the NEAR sent to the token account at deployment covers that one account.

Invariants (tested):
1. `pool_tokens + sum(loud) + sum(quiet) + escrowed == total_supply`
2. `loud_outstanding == sum(loud) + escrowed`
3. `loud_outstanding` never increases after `loud_until`.
4. For any interval `[t0, t1]`, loud units leaving the contract path `<= bucket(t0) + cap_units * (t1 - t0) / cap_window_ns`, whatever the number of accounts.
5. The contract's NEAR balance always covers `pool_near + owed_total`. (The unit tests check the `owed` and `owed_total` bookkeeping; the account balance itself is outside the mocked environment.)

Every account with a non-zero `loud` or `quiet` balance or an open exit is registered, because tokens only reach an account through `new`, `buy`, `catch` by a registered caller or a transfer to a registered receiver. The random-sequence unit test asserts this for the balances after every step. Storage payments stay in the token account's balance and are counted in neither `pool_near` nor `owed_total`.

## 5. Pool math (constant product with a virtual NEAR reserve)

Let `R = virtual_near + pool_near`, `T = pool_tokens`.

- Buy with `n` yoctoNEAR entering the pool (the attached deposit, less the storage payment of a first buy, section 7): `out = mul_div(T, n, R + n)`. Then `pool_near += n`, `pool_tokens -= out`. Requires `out > 0` and `out < T`.
- Sell `x` units: `near_out = mul_div(R, x, T + x)`. Requires `near_out > 0` (else `E_AMOUNT`) and `near_out <= pool_near` (else `E_POOL_EMPTY`). Every sale of up to `max_sell = mul_div(pool_near, T, virtual_near)` units is payable. Then `pool_near -= near_out`, `pool_tokens += x`.
- Spot price for display: `R / T` (yoctoNEAR per unit).
- No fee on `buy`, `sell` or `leave`. The only fee is the 1% of a `catch` price that stays in the pool (section 7). The storage payment is a fixed 0.03 NEAR per account, taken once and kept outside the pool.

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

Errors are panics whose message starts with the code, for example `E_NOTICE: ...`. Codes are listed per method. Every state-changing method refills the bucket first, with two exceptions: `storage_deposit`, which only registers an account, and the callback `on_payout`, which only records a failed payout. The full list also includes `E_SELF` (sender equals receiver), `E_NO_EXIT` (unknown exit id), `E_MATH` (pool math overflow), `E_UNREGISTERED` (the receiver of a transfer has not paid storage) and `E_AMOUNT` (zero amount, a buy that rounds to zero tokens, or a sale that rounds to zero yoctoNEAR).

**Payouts.** Every non-zero NEAR payout (`sell`, `leave`, `catch` to the exit owner and its refund to the caller, `claim`, the `storage_deposit` refund) is a transfer receipt followed by the callback `on_payout` on the token account, with 10 Tgas reserved for the callback out of the gas attached to the call. The pair is detached: the method returns its own value and does not wait for the transfer.

### Init
- `new(total_supply, creator, creator_alloc_bps, virtual_near, loud_window_ns, notice_ns, exit_window_ns, cap_bps, cap_window_ns, name, symbol, icon?)`: `#[init]`, callable once (`E_INIT`). `E_PARAMS` if a value is outside the bounds of section 3, if `creator` is the token account, or if `name`, `symbol` or `icon` is longer than its cap. Registers `creator`. Emits NEP-141 `ft_mint` for the creator allocation (if > 0) and for the pool inventory (owner = contract account).

### Trading
- `buy(min_tokens_out: U128) -> U128`: payable. If the caller is not registered, the contract registers it and keeps `STORAGE_MIN_YOCTO` of the attached deposit before the pool math: `storage_paid = STORAGE_MIN_YOCTO` and `n = deposit - storage_paid`. For a registered caller `storage_paid = 0` and `n = deposit`. `n >= 10^21` (`E_DEPOSIT`, also when the deposit of an unregistered caller is below the storage payment), so a first buy attaches at least 0.031 NEAR. The caller is registered only after every check of the buy has passed. `out` per section 5 for `n`; `out >= min_tokens_out` (`E_SLIPPAGE`). If `now < loud_until`: `loud[caller] += out`, `loud_outstanding += out`; else `quiet[caller] += out`. Event `buy { account, near_in, tokens_out, loud: bool, storage_paid }`, where `near_in = n` is the NEAR that entered the pool, and NEP-141 `ft_transfer` from the contract account.
- `sell(amount: U128, min_near_out: U128) -> U128 (yoctoNEAR sent)`: requires exactly 1 yoctoNEAR attached (`E_YOCTO`). Uses **quiet only**: `amount <= quiet[caller]` (`E_NO_QUIET`; the message states the caller's loud and quiet balances and says loud must use shout/leave). `near_out` per section 5, `>= min_near_out` (`E_SLIPPAGE`); a sale is never partial, so the limit is absolute. Pays NEAR to the caller (see Payouts). Event `sell { account, tokens_in, near_out }` and NEP-141 `ft_transfer` to the contract account.

### The door for loud tokens
- `shout(amount: U128) -> U64`: 1 yocto. `0 < amount <= loud[caller]` (`E_NO_LOUD`). `amount >= total_supply / 1_000_000`, or `amount == loud[caller]` while the caller has no open exit (`E_DUST` otherwise). The floor keeps holders from cutting a balance into many tiny exits. The exception lets a whole loud balance below the floor use the door once the caller's other exits are closed, so an account has at most one open exit that was shouted below the floor. Checks run in this order: `E_NO_LOUD`, `E_DUST`, `E_TOO_MANY`. Moves `amount` from `loud[caller]` to escrow, where it stays until it is sold with `leave`, caught with `catch`, or returned by `hush` after the exit has expired. Creates `Exit` with `ready_at = now + notice_ns`, `expires_at = ready_at + exit_window_ns`. At most 8 open exits per account (`E_TOO_MANY`). Event `shout { id, account, amount, ready_at, expires_at }`. Returns the id.
- `leave(exit_id: U64, min_near_out: U128) -> U128 (units filled)`: 1 yocto. Caller is the exit owner (`E_NOT_OWNER`). `ready_at <= now` (`E_NOTICE`, message states seconds left). `now <= expires_at` (`E_EXPIRED`). `fill = min(exit.remaining, available(now))`, `fill > 0` (`E_CAP`, message states when room returns). If the pool cannot pay for `fill` (section 5), `fill = min(fill, max_sell)`, and `E_POOL_EMPTY` if that is 0; the rest stays in the exit. `near_out` per section 5 for `fill` (`E_AMOUNT` if it rounds to 0: retry with more room; a remainder that small goes back with `hush` once the exit has expired). Price limit: `min_near_out` is the least NEAR the caller accepts for everything left in the exit, and a partial fill is held to the same price. With `remaining_before = exit.remaining` read before this fill, the call fails with `E_SLIPPAGE` if `near_out * remaining_before < min_near_out * fill`; both products are compared exactly in 256 bits, with no division. So `min_near_out = 0` always passes, a fill of the whole remainder needs exactly `near_out >= min_near_out`, and the quote for the whole remainder is a limit a partial fill can meet. `remaining` shrinks with every fill, so a caller quotes again before the next call. The check runs after `E_AMOUNT` and `E_POOL_EMPTY` and before any state change. Effects: `bucket_units -= fill`, `escrowed -= fill`, `loud_outstanding -= fill`, `exit.remaining -= fill`, pool sell per section 5, NEAR paid to the owner (see Payouts). If `remaining == 0` the exit is removed. Event `leave { id, account, filled, remaining, near_out }`.
- `hush(exit_id: U64)`: 1 yocto. Unknown id: `E_NO_EXIT`. A shout is binding: while `now <= expires_at` the call fails with `E_NOTICE_BINDING` for every caller, the owner included. After `expires_at` anyone may call. Returns `remaining` to `loud[owner]` (still loud), removes the exit, `escrowed -= remaining`. Event `hush`. A shouted amount that is neither sold nor caught therefore stays in escrow for at least the notice period plus the exit window, until someone calls `hush`.
- `catch(exit_id: U64, amount?: U128) -> U128 (units caught)`: payable. Anyone but the exit owner (`E_SELF`) can take tokens out of an open exit by paying the owner for them, so that part of the announced sale never reaches the pool. The owner cannot refuse. Unknown id: `E_NO_EXIT`. The caller is registered (`E_UNREGISTERED`: call `storage_deposit` first). Open from the block of the shout until `expires_at`, the notice period included (`E_EXPIRED` after). `amount` defaults to `exit.remaining`; `0 < amount <= exit.remaining` (`E_AMOUNT`). If the catch would leave `0 < remaining - amount < total_supply / 1_000_000` in the exit it fails with `E_DUST`: catch the whole remainder instead. Price: `live = sell_out(pool_tokens, reserve, amount)` per section 5, the NEAR the pool would pay for that amount at this moment, whether or not the pool could actually pay it (`E_MATH` on overflow). `floor = ceil(exit.shout_quote * amount / exit.amount)`, where `exit.amount` is the amount first shouted and `exit.shout_quote` is the pool's sell quote for it, read in `shout` before the tokens moved (256-bit intermediate). `quote = max(live, floor)`; `quote > 0` (`E_AMOUNT`). The floor means that pushing the pool price down before a catch does not make it cheaper; pieces that add up to a whole exit pay at least its shout-time quote. The attached deposit is at least `quote` (`E_DEPOSIT`, message states the quote); anything above it is refunded to the caller. `fee = quote * CATCH_FEE_BPS / 10_000`, rounded down, with `CATCH_FEE_BPS = 100` (1%), a constant of the contract. Effects: `exit.remaining -= amount` (the exit is removed at 0), `escrowed -= amount`, `loud[caller] += amount`: caught tokens stay loud. `pool_near += fee`; the owner is paid `quote - fee`. `pool_tokens`, the bucket and `loud_outstanding` do not change. `total_caught += amount`, `catch_count += 1` (saturating). Payments are payouts (see Payouts). Events: NEP-141 `ft_transfer` from the token account to the caller with memo `catch`, and `catch { id, account, catcher, amount, remaining, near_paid, fee }` where `account` is the exit owner and `near_paid` is `quote`. The cap does not apply: a caught exit pays its owner at once, sells nothing into the pool and leaves the supply loud in the catcher's hands; the pool price moves only by the fee the pool keeps. The 1% fee stays in the pool, so taking back one's own shout through a second account costs 1% of its value. `quote_catch(exit_id: U64, amount?: U128) -> { near_in, fee }` is the view for it.

### Failed payouts
- `on_payout(account: AccountId, amount: U128)`: `#[private]` callback of every payout; only the token account can call it (`E_PRIVATE` names the same rule inside the method body; on chain the `#[private]` wrapper rejects other callers first). If the transfer receipt failed, the NEAR has come back to the token account: `owed[account] += amount`, `owed_total += amount`, event `payout_failed { account, amount }`. If the transfer succeeded, nothing changes. `pool_near` is not touched in either case; it was reduced when the sale happened. The callback does nothing else and does not refill the bucket: the less it does, the less can stop it from recording the debt. The bucket loses nothing by this, because the next state-changing call refills it for the whole time since `bucket_ts`.
- `claim() -> U128 (yoctoNEAR sent)`: 1 yocto (`E_YOCTO`). `owed[caller] > 0` (`E_NOTHING_OWED`). Removes the caller's entry, `owed_total -= amount`, then pays the whole amount to the caller through the same payout path, so a transfer that fails again is recorded again. Event `claim { account, amount }`.
- `get_owed(account_id) -> U128`: view, yoctoNEAR owed to the account (0 if none).

### NEP-141
- `ft_transfer(receiver_id, amount, memo?)`: 1 yocto. Sender and receiver differ (`E_SELF`). The receiver is not the token account itself (`E_RECEIVER`: the account has no key, so tokens credited to its own balance could never move again). The receiver is registered (`E_UNREGISTERED`); the sender needs no check, because a holder is always registered. Takes **quiet first, then loud** from the sender; the receiver gets the same split (loud stays loud). `E_BALANCE` if `amount > loud + quiet`. Event: NEP-141 `ft_transfer`, plus `tag_move { from, to, loud_amount }` when `loud_amount > 0`.
- `transfer_loud(receiver_id, amount)`: 1 yocto. Moves loud explicitly (for OTC). Same receiver checks as `ft_transfer` (`E_SELF`, `E_RECEIVER`, `E_UNREGISTERED`). `0 < amount <= loud[sender]` (`E_NO_LOUD`).
- `ft_transfer_call(receiver_id, amount, memo?, msg)`: 1 yocto. Same receiver checks as `ft_transfer` (`E_SELF`, `E_RECEIVER`, `E_UNREGISTERED`), so a receiving contract is registered with `storage_deposit` first. **Quiet only** (`E_QUIET_DOOR`: loud tokens cannot go into other contracts through `ft_transfer_call`). Standard `ft_on_transfer` + `ft_resolve_transfer`; refunds go back as quiet. Gas: 30 Tgas for `ft_on_transfer`, 10 Tgas for resolve.
- `ft_total_supply`, `ft_balance_of` (= loud + quiet; for the token account itself `pool_tokens + escrowed` is added, because the NEP-141 events name it as the owner of the pool inventory and the escrow, so all balances sum to `ft_total_supply`; the token account's own `loud` and `quiet` entries stay empty, because transfers to it fail with `E_RECEIVER` and `new` rejects it as `creator`), `ft_metadata` (spec `ft-1.0.0`, decimals 18).

### Storage registration (NEP-145)
Account owners pay for their own storage. An account pays `STORAGE_MIN_YOCTO` (0.03 NEAR) once and is then registered for good. At 10^19 yoctoNEAR per byte that is 3,000 bytes. By the byte estimate in the contract source, an account with the longest id (64 bytes) uses 597 bytes for its two balance entries, the registration entry, an `owed` entry and its list of open exits, and 286 bytes more per open exit: 2,885 bytes with all 8 exits open. The payment therefore covers an account and every exit it can have open. An account becomes registered in one of three ways: as `creator` in `new`, on its first `buy`, or through `storage_deposit` (its own call or anyone else's).

- `storage_deposit(account_id?: AccountId, registration_only?: bool) -> { total, available: "0" }`: payable. `account_id` defaults to the caller. If the account is not registered: the deposit is at least `STORAGE_MIN_YOCTO` (`E_STORAGE`), the contract keeps exactly that amount, registers the account and refunds the rest to the caller. If it is already registered, the whole deposit goes back to the caller. `registration_only` is accepted for wallet compatibility and changes nothing, because the contract never keeps more than the minimum. Refunds are payouts (see Payouts).
- `storage_balance_of(account_id) -> { total, available } | null`: `null` for an unregistered account, `{ total: STORAGE_MIN_YOCTO, available: "0" }` for a registered one.
- `storage_balance_bounds() -> { min, max }`: both equal `STORAGE_MIN_YOCTO`.
- `is_registered(account_id) -> bool`: view.
- There is no `storage_withdraw` and no `storage_unregister`. The payment is never returned and a registration cannot be removed, also when the account holds nothing any more.

The JavaScript engine (`web/engine.js`) keeps no registration and charges no storage, so `E_STORAGE` and `E_UNREGISTERED` exist only in the contract.

### Views
- `get_params() -> Params` (all of section 3 plus `launch_ts`, `loud_until`, `cap_units`, `creator_alloc`).
- `get_state() -> State { pool_tokens, pool_near, loud_outstanding, escrowed, cap_available, cap_units, next_room_ts, cap_full_ts, open_exits, total_shouted, total_left, total_caught, shout_count, leave_count, catch_count, now, is_loud_window, owed_total }`: `cap_available` computed for the current block time; `next_room_ts` is the earliest time with at least one unit of room, `cap_full_ts` the time the bucket is full again if nobody leaves; `owed_total` is the yoctoNEAR of failed payouts waiting for `claim`.
- `get_account(account_id) -> { loud, quiet, exits: [Exit] }`
- `get_exits(from_index: u32, limit: u32) -> [Exit]` (`limit <= 100`; reads at most 100 exits per call. With up to 100 open exits they are ordered by id before paging. With more, pages follow storage order, each page is ordered by id, and a reader collects all pages and sorts by id).
- `quote_buy(near: U128) -> U128` (for the NEAR that enters the pool; a first buy pays 0.03 NEAR storage on top), `quote_sell(amount: U128) -> U128`.

### Events
NEP-297, `standard: "loud"`, `version: "1.0.0"`, events `buy`, `sell`, `shout`, `leave`, `hush`, `catch`, `tag_move`, `payout_failed`, `claim`. NEP-141 events use `standard: "nep141"`.

### No admin
No owner, no pause, no upgrade method, no parameter setter. The token account is created, funded, deployed and initialised in one batch transaction that never adds an access key, so the account has zero keys from its first block.

## 8. What anyone can check

1. **Split test (unit test and on-chain proof).** One account holds `X` loud units. Scenario A: it shouts and leaves alone. Scenario B: it first splits `X` across `N` accounts (N = 100 in the unit test, 20 on testnet) and every account shouts and leaves as fast as allowed. In both, total loud units sold in any cap window `<= available(window start) + cap_units` (invariant 4; never more than `2 * cap_units`, and `cap_units` per window on average), and A == B within one unit of rounding per account. On testnet the proof runs scenario B only (N = 20) and checks the total against the invariant 4 bound, which does not depend on the number of accounts; the cap is global per token, so A cannot run on the same token in the same window. A == B is checked in the contract unit test (N = 100) and in the engine tests (`web/engine.test.mjs`, 1 vs 100 wallets).
2. **Tag follows the tokens.** After splitting, every receiving account shows a loud balance and `sell` fails with `E_NO_QUIET`.
3. **Pool buyers stay clean.** An account that buys after `loud_until` holds only quiet and can sell immediately.
4. **Comparison baselines in the simulator** (not on chain): `naive` (no rule) and `per_wallet` (max sell 0.5% of supply per transaction, 60 s cooldown per wallet, the per-wallet rule modelled here). With 1 wallet vs 100 wallets: `naive` dumps everything at once in both, `per_wallet` lets 100 wallets sell 100 times as much per minute as one while they hold enough (a position of 5% of supply is gone in 1 minute against 10), `loud` is identical for 1 and 100.
5. **Zero keys.** `view_access_key_list` on the token account returns an empty list.
6. **Storage and binding shouts (unit tests, and the testnet script).** A transfer to an unregistered account fails with `E_UNREGISTERED`. The first buy of an unregistered account raises `pool_near` by the deposit less 0.03 NEAR. `hush` on an exit that has not expired fails with `E_NOTICE_BINDING` and the exit stays open. The unit tests check all three. The testnet script checks the two refusals in its steps 5 and 8; a recorded run shows them only if `web/receipts.json` has the `token_near` key, because a file without it was recorded before these rules existed.

## 9. Limits (stated plainly, also in the README)

- **Leave, then buy back.** After `loud_until` every buy is quiet and `buy`, `sell` and `leave` carry no fee. A holder can call `leave` for `x` units and, in the same transaction, `buy` with its own NEAR equal to the payout. The pool is back where it was and the holder has `x` quiet units, less rounding. Quiet units sell in one call with no notice and no cap. Each `leave` still respects the bucket, so the bucket sets how fast early supply can be sold or converted to quiet. It does not bound a later sale of the tokens bought back. The buy can also come from another account, so the contract cannot tell a conversion from a sale. Every conversion is on chain as a `shout` and a `leave`. The simulations assume a seller who does not do this.
- **A standing notice.** Shouting costs nothing but the lock, and loud tokens have no other use. A holder can keep exits open one after another, 8 per account, so that some exit is always ready. The notice then says a sale may come and gives no exact time.
- **Wrappers and off-pool deals.** Someone can send loud tokens to a custom contract with plain `ft_transfer` or `transfer_loud` and trade claims on them, sell the account itself, or sell OTC. The loud tokens keep their tag wherever they sit, and whoever takes them out faces the same door. A buyer of a claim or of a wrapper token holds no tag and can sell it with no notice. LOUD limits the pool exit only.
- **Other pools.** `ft_transfer_call` refuses loud tokens, so a DEX that takes deposits through it rejects them. A plain transfer to a registered contract is not refused. Quiet tokens can trade anywhere.
- **First come, first served.** Ready exits share the cap in the order their `leave` calls land. A large holder can take a whole window's room, and one who keeps calling `leave` can take every refill until the others' exits expire. Splitting gives no extra room, but it does not give others priority either.
- **The launch window can be sidestepped.** The tag depends on one thing only: whether the buy happened before `loud_until`. Nothing makes anyone buy inside the window. Whoever waits and buys right after it gets quiet tokens at the pool price of that moment and can sell them at once, with no notice and no cap. The door therefore binds the creator allocation and those who chose to buy inside the window; it does not bind a bundle or sniper that buys just after it. The simulation scenarios with a bundle assume it buys inside the window.
- **Early honest buyers are loud too.** Anyone who buys in the launch window accepts the door. The page's sandbox shows next to its clock that the window is open and buys are loud.
- **A shout does not have to end in a sale.** `hush` fails until the exit has expired, so the owner's account cannot withdraw a shout; a second account can, by catching it for the 1% fee. Nothing forces the `leave`, though: a holder can shout, let the notice and the exit window pass, and take the tokens back. The price of such a notice is that the tokens stay in escrow for at least the notice period plus the exit window, during which the owner cannot move or sell them, unless another account catches them.
- **Notice can trigger a rush.** Quiet holders can sell before a shouted exit becomes ready. That is the intended information, and it can also accelerate a sell-off.
- **No identity.** The contract does not know who is an insider and does not try to.
- **The creator allocation is unbacked.** It is minted without a NEAR payment, so every NEAR it receives through the door comes from buyers. After the creator has left, the pool cannot pay the formula price to all remaining holders; the shortfall is at most the creator's proceeds. `sell` fails with `E_POOL_EMPTY` when the pool cannot pay the formula amount, and `leave` fills only the part the pool can pay. So the last sellers may be unable to sell part or all of their tokens.
- **Storage is paid once and never returned.** Every account but the creator's needs 0.03 NEAR paid before it can hold tokens, on its first buy or through `storage_deposit`. There is no withdraw and no unregister, so the payment stays in the token account also after the holder has sold everything. A transfer to an unregistered account fails with `E_UNREGISTERED`, which makes airdrops and first transfers one step longer. The payment covers an account with all eight exits open.
- **Tiny exits.** An account whose whole loud balance is below the dust floor may still shout it when it has no other open exit. So someone willing to pay 0.03 NEAR per account can put small rows on the board, one per account. An exit too small to pay 1 yoctoNEAR cannot be filled (`leave` fails with `E_AMOUNT`) and goes back through `hush` after it has expired. Above 100 open exits `get_exits` pages in storage order (section 7).
- **Failed payouts.** A payout can fail in two ways. If the `sell`, `leave`, `catch` or `claim` call itself fails, nothing changes: the seller keeps the tokens (or the recorded debt) and can call again. If the call succeeds and only its transfer receipt fails, for example because the receiving account was deleted, `on_payout` records the amount under `owed` and the account collects it with `claim`. Nothing retries automatically. The record depends on that callback: if `on_payout` itself fails, for example by running out of gas, nothing is recorded and the NEAR stays in the token account with no claim on it.
- **Catch.** A caught exit pays its owner at once, however large, so an insider with a willing buyer cashes out faster than the cap, with no sale into the pool and with the supply still loud. A holder can take back their own shout through a second account for the 1% fee, which makes a bluff shout cheap: shout, let others sell first, take it back. The catch price never falls below the shout-time quote, so lowering the pool price first does not make a catch cheaper; the catcher's only price limit is the deposit they attach. A catch just before the owner's `leave` can make that `leave` fail with `E_SLIPPAGE` or `E_NO_EXIT`.
- **Testnet only.** The code is unaudited, the only fee is the 1% catch fee and there is no liquidity migration.
- **Sybil resistance.** The cap is global, so more accounts never mean more exit room. They do mean more exit slots, 8 per account. The global cap is the whole sybil defence; there is no per-person fairness.
