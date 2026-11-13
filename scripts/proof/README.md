# Proof run

`proof.mjs` deploys LOUD to NEAR testnet and runs the checks of SPEC section 8 against the live contract. It writes two files that the web page reads:

- `web/deployment.json`: where the token lives and whether its account has zero access keys.
- `web/receipts.json`: every step, with the hash of every transaction the script broadcast. When a send is retried with a new nonce or block hash, the hash of each earlier broadcast stays in the record (`earlier_attempts`). A transaction whose outcome no RPC endpoint confirmed is listed as `unknown` and counted as unresolved, apart from the ones that were not executed (see "Outcomes" below). The faucet's own account-creation transaction is listed only when the faucet returns its hash (see step 1 below); the saved run lists it.

It runs only in GitHub Actions (`.github/workflows/proof.yml`, manual trigger). All keys are generated in memory inside the job and are never written to disk or to the log. Nothing here needs a secret.

## What it does

The step numbers are the ones used in `receipts.json`. Step 3 runs before step 2 so that the 2 minute loud window is not spent on account creation.

| n | Step | Expectation |
|---|---|---|
| 1 | Create a fresh root account `loud-<random>.testnet` through the testnet faucet | account exists and holds enough NEAR |
| 2 | Create `t.<root>` in one batch transaction: CreateAccount, Transfer, DeployContract, FunctionCall `new` (demo preset, creator = insider). No AddKey | `view_access_key_list` is empty; the on-chain `code_hash` equals base58(sha256) of the built wasm; `get_params` equals the preset; `storage_balance_bounds().min` is 0.02 NEAR; `storage_balance_of` of an account that is not registered is `null`; the creator is registered |
| 3 | Create `insider`, `w01`..`w20` and `late` under the root | 22 accounts |
| 4 | The insider buys with 1 NEAR in the loud window | bought tokens are loud; `pool_near` rises by the full 1 NEAR, because the insider is the creator and `new` registered it |
| 5 | The insider sends 1 unit to a wallet that is not registered. Then all 20 wallets call `storage_deposit` with 0.02 NEAR. Then the insider splits its whole loud balance across them with `ft_transfer` | the first transfer fails with `E_UNREGISTERED`; all 20 wallets are registered; every wallet holds loud, no quiet |
| 6 | One wallet calls `sell()` | fails with `E_NO_QUIET` |
| 7 | After the loud window the late buyer buys with 0.5 NEAR and sells half | holds quiet only; the buy registers the buyer and `pool_near` rises by 0.48 NEAR; the sell succeeds and none of its receipts failed |
| 8 | All 20 wallets `shout` their full balance; one calls `leave()` at once and then `hush()` on the same exit | 20 open exits; the leave fails with `E_NOTICE`; the hush fails with `E_NOTICE_BINDING` and the exit stays open |
| 9 | After the notice all 20 wallets call `leave()` in rounds for one full cap window | at least one fill; calls that executed and failed did so with `E_CAP` (or `E_EXPIRED` at the end); no successful leave has a failed receipt or a `payout_failed` event. Calls that were not executed and calls whose outcome stayed unknown are counted apart and do not fail the step |
| 10 | Compare what left with the cap, measured over the full cap window | `sold_total <= bucket_at_start + cap_units * elapsed / cap_window_ns` (SPEC invariant 4), and the conditions listed below |

Step 1: the root account is created by the faucet service, with a transaction that the faucet signs. If the faucet's HTTP answer carries a transaction hash, it is recorded in the step's `txs` as returned (its `outcome` is `unknown` unless the answer also carries a status); the script does not look that transaction up. If the answer carries none, `txs` stays empty and the step text says that the faucet's own transaction is not recorded. Top-up accounts are handled the same way. In the saved `web/receipts.json` the faucet did return a hash and a status, so step 1 lists that transaction with the outcome `success`, as returned.

Step 2 fails if the token account has an access key, if its `code_hash` differs from the hash of the wasm that the build job produced, or if `get_params` differs from the intended preset. The comparison covers the nine constructor values of SPEC section 3 and the two derived values `cap_units = total_supply * cap_bps / 10000` and `loud_until = launch_ts + loud_window_ns`.

Storage (steps 2, 4, 5 and 7): an account pays 0.02 NEAR once to be registered, and only a registered account can receive tokens. The run pays this the way a user would.

- The 20 wallets each call `storage_deposit` for themselves, all at the same time, right before the split. The deposit is exactly 0.02 NEAR, so nothing is refunded. Whether a wallet is registered is read from `is_registered`, not from the send result. A wallet that is still not registered sends once more; a deposit for a registered account is refunded in full.
- The late buyer does nothing extra. Its first `buy` takes 0.02 NEAR out of the attached 0.5 NEAR and puts 0.48 NEAR into the pool.
- The insider is the creator, and `new` registers the creator, so its buy pays nothing for storage.
- The registrations run after the insider's buy, so they take no time from the 2 minute loud window. Only the reads of step 2 sit between the deploy and the buy. If the buy landed after the window, its tokens would be quiet and step 4 would fail.

How a buy is checked: the script reads `is_registered(buyer)` and `get_state().pool_near` before the buy and `pool_near` again after it. The change must equal the attached NEAR, less 0.02 NEAR if the buyer was not registered. Nothing is computed from a local price formula. The `buy` event is read as well: its `near_in` and `storage_paid` must agree when they are present. A field that is missing is named in the step text and does not fail the step. Step 7 also needs `is_registered(late buyer)` to change from `false` to `true`.

Step 8, the hush: a shout is binding. `hush` fails with `E_NOTICE_BINDING` for everyone, the owner included, until the exit has expired. The wallet whose early `leave` was refused calls `hush` on the same exit right after it. The step needs that call to fail with this code and the exit to be still open. `early_hush.before_ready` says whether the call landed before the notice ended; it has to fail either way, because the exit has not expired.

Closing record: after step 10 the script reads the token account and `get_state` once more and writes `token_near.at_end` and `owed_total_at_end` (expected `"0"`: no payout failed). The same reading right after the deploy is in `token_near.at_deploy`. `spare` is the account balance minus `pool_near`, that is, the NEAR that is not pool liquidity. `storage_stake` is what the protocol locks for the account's state (code and records), and `free` is what is left after that and after `owed_total`. These values are recorded only: no step depends on them.

Payouts (step 7 sell, step 9 leaves): the contract pays NEAR with a detached transfer followed by its own `on_payout` callback, so a failed payout does not change the top-level status of the call. The transfer shows as a failed entry of `receipts_outcome`, and the callback, which records the unpaid amount for `claim()`, logs a `payout_failed` event. The script therefore reads every entry of `receipts_outcome` of the final transaction result and the logs of each. A successful call counts as settled only when the result lists at least one receipt outcome, every one of them is a success, and no receipt log carries a `payout_failed` event. The amount paid is not compared with a quote; the check is that no receipt of the transaction failed and no payout was recorded as unpaid. `sell` and `leave` are sent with 80 Tgas, of which the contract reserves 10 Tgas for the callback.

Step 10 passes only when all of these hold:

- the measurement covers the full cap window: `measured_until_ns - window_start_ns >= cap_window_ns`. There is no tolerance; after the leave rounds the script waits until chain time has passed `window_end_ns` and only then reads the closing `get_state`;
- the run was not cut short (runtime limit or an RPC failure before the end of the window);
- at least one leave filled, and every fill has a block time inside the measured interval;
- the sum of the per-transaction fills equals the change of the contract counter `total_left` (`receipts_match_counter`);
- no fill has a failed receipt or a `payout_failed` event;
- `sold_total <= bound` and `sold_in_window <= bucket_at_start + cap_units`.

When step 10 does not pass, `split.fail_reasons` lists the conditions that failed.

Notes on step 9 and 10:

- The cap bucket refills continuously, so a call that lands alone in a block usually fills a small amount. `E_CAP` shows up when several calls land in the same block. All 20 wallets send in the same round every `ROUND_SECONDS` (default 20); a wallet that hits `E_CAP` sends again in the next round.
- `bucket_at_start` and `window_start_ns` come from one `get_state` call after the last notice ended. `sold_total` is the change of the contract counter `total_left`; the per-transaction fills are the evidence, and `receipts_match_counter` says whether the two agree.
- A leave call whose result no RPC endpoint confirmed is looked up once more by hash after the last round and before step 9 is closed, and a fill without a block time gets one more block lookup. A call that this lookup confirms gets its real outcome and `resolved_late: true`. A call that stays unconfirmed is listed as `unknown` and counted as unresolved, never as "not executed": the script cannot tell whether it never executed or executed and failed.
- The cap check of step 10 rests on the contract counter `total_left`, not on the per-transaction statuses. When the fills on record add up to the counter (`receipts_match_counter`), no unresolved call added a fill in the measured interval; if one did fill, the sum no longer matches and step 10 fails. The step 10 text says so, and names the number of unresolved leave calls when there are any.
- The exits expire one exit window after their notice ended, which in the demo preset is the same length as the cap window, so the last round can end with `E_EXPIRED`.

Scope of the split test: SPEC section 8.1 describes scenario A (one account alone) and scenario B (split across N accounts). This run executes scenario B only, with N = 20. The cap is global per token, so A cannot run on the same token in the same window. Step 10 checks the total against the invariant 4 bound, which does not depend on the number of accounts. A == B is checked in the contract unit test (N = 100) and in the engine tests (`web/engine.test.mjs`, 1 vs 100 wallets).

## Outcomes: executed and failed, not executed, unresolved

Every transaction record has one of four `outcome` values, and the counts keep three kinds of non-success apart:

| Group | `outcome` | Meaning | Count in step 9 and `split` |
|---|---|---|---|
| executed and failed | `failure` | the transaction ran on chain and failed; the error text (and for a leave the `error_code`) is on record | `executed_failed` (= `cap_hits` + `E_EXPIRED` + other) |
| not executed | `invalid`, or `unknown` with `hash: null` | a node refused the transaction before execution, or the script failed before it could broadcast it | `not_executed` |
| unresolved | `unknown` with a hash | the transaction was broadcast and no RPC endpoint returned a final result, neither while polling (120 s) nor on one more lookup by hash. It may never have executed, or it may have executed | `unresolved` |

One more lookup by hash (RPC `tx` with `wait_until: FINAL`, through the same client and failover as every other call) is made for each `unknown` transaction: for the leave calls before step 9 is closed, for all other steps when the run ends, also when it stopped early. A record that the lookup confirms gets its real outcome and `resolved_late: true`. The same lookup is made for an `invalid` record that a node refused with `InvalidNonce`, because the client re-posts a signed transaction to the next endpoint after a transport failure, and the second post is refused with that error when the first one landed. The later lookups stop after 3 minutes or 4 minutes past `MAX_RUNTIME_MINUTES`, whichever comes first; what was not reached stays as it was. The client changes endpoint only on a transport failure; a node's answer "not seen" (`TIMEOUT_ERROR`, `UNKNOWN_TRANSACTION`) is taken as the answer for that lookup.

Retries: a send that a node refuses with `InvalidNonce` or `Expired` is signed again with a fresh nonce and block hash, up to two times. Each earlier broadcast has its own hash, and all of them are kept in the record under `earlier_attempts`, oldest first. Each of these hashes is looked up as well, and `earlier_attempt_outcomes` holds the result: the real outcome when the lookup finds the transaction on chain, `invalid` when the lookup does not find it either, `unknown` when the lookup itself failed. In step 9 an earlier broadcast that did execute is a leave call of its own: it gets its own record, marked `retried_as` with the hash of the retry, so that its fill is counted in step 10.

The run result: `status` is `ok` when all 10 steps passed, and an unresolved transaction does not change it. `unresolved_txs` is the number of transactions the script sent whose outcome stayed unknown (records with the outcome `unknown` and a hash, plus earlier broadcasts without a confirmed outcome), `unresolved_hashes` lists them and `unresolved_note` says it in one plain paragraph. When `unresolved_txs` is above 0, "all steps passed" has to be read with that qualification: every step expectation held, and the outcome of that many transactions is not known. The last line of the job log says the same. Transactions the faucet signed are not counted: the script did not send them.

The script exits non-zero if any expectation fails. It writes both files in every case.

## Run

GitHub: Actions, workflow `proof`, "Run workflow". Input `preset` accepts `demo` only (the `standard` preset takes longer than the job limit). The `build` job builds the wasm; the `proof` job downloads it, runs the script with a read-only token and uploads the two JSON files as an artifact; the `record` job, which runs no npm code, commits them as `github-actions[bot]`. A failed run is committed only when the input `commit_on_failure` is set, so a failed re-run does not replace an earlier good result. A run takes about 17 minutes after the build.

Environment variables (all optional):

| Name | Default | Meaning |
|---|---|---|
| `PRESET` | `demo` | parameter preset of SPEC section 3 |
| `LOUD_WASM` | `build/loud.wasm` | contract wasm |
| `NEAR_RPC_URLS` | FastNEAR testnet, then `rpc.testnet.near.org`, then dRPC | comma-separated RPC list, tried in order |
| `NEAR_FAUCET_URLS` | `helper.nearprotocol.com/account`, `helper.testnet.near.org/account` | comma-separated faucet list |
| `ROUND_SECONDS` | `20` | pause between leave rounds |
| `MAX_RUNTIME_MINUTES` | `24` | the script stops and writes its files after this; a run stopped before the end of the cap window is recorded as failed |

`rpc.testnet.near.org` is not the first RPC because the NEAR docs (docs.near.org/api/rpc/providers) list the near.org endpoints as severely rate limited, and this run sends several hundred transactions.

Funding: the root account pays for everything. The token account gets 10^19 yoctoNEAR per byte of wasm plus 0.5 NEAR. The insider gets 1.25 NEAR and the late buyer 0.65 NEAR. Each wallet gets 0.12 to 0.27 NEAR: 0.02 NEAR for its registration and the rest for gas. With a wasm of about 230 KB the run needs about 7.4 NEAR, and one faucet grant was 10 NEAR in the saved run.

If one faucet grant is smaller than the run needs, the script creates up to three more faucet accounts and deletes each with the root as beneficiary.

## Files

| File | Role |
|---|---|
| `proof.mjs` | the run |
| `rpc.mjs` | JSON-RPC client with failover, no dependencies |
| `lib.mjs` | pure helpers (amounts, budget, error codes, the buy check, the cap bound and the step 10 verdict, receipt settlement, the preset comparison, the split of the token account's NEAR, base58) |
| `lib.test.mjs` | `node --test` for `lib.mjs`; runs in CI |
| `package.json` | one pinned dependency, `near-api-js` 5.1.1, used for keys, actions and borsh encoding. Installed in Actions with `npm install --ignore-scripts` |

## Schema: `web/deployment.json`

All token and NEAR amounts and all nanosecond timestamps are decimal strings.

```
{
  "status": "pending" | "ok" | "failed",   // "ok": deployed, zero_keys is true, code hash and params match
  "network": "testnet",
  "preset": "demo",
  "token_account": "t.loud-xxxx.testnet" | null,
  "root_account": "loud-xxxx.testnet" | null,
  "creator_account": "insider.loud-xxxx.testnet" | null,
  "params": { ...arguments passed to new(), SPEC section 3... } | null,
  "onchain_params": { ...result of get_params()... } | null,
  "deployed_at": "2026-01-01T00:00:00.000Z" | null,   // block time of the deploy
  "deployed_at_ns": "..." | null,
  "tx": "<hash of the batch transaction>" | null,
  "zero_keys": true | false,
  "access_keys": [] | null,                 // public keys from view_access_key_list
  "wasm": { "bytes": 0, "sha256": "<hex>" } | null,
  "code_hash": "<base58>" | null,           // read from the token account
  "expected_code_hash": "<base58>" | null,  // base58 of the sha256 of the built wasm
  "code_hash_match": true | false | null,
  "params_match": true | false | null,      // get_params against the preset, see step 2
  "param_mismatches": ["<key>: intended ..., on chain ..."] | null,
  "explorer": { "token": "<url>", "root": "<url>", "tx": "<url>" },   // each may be null
  "run": { "repository": "...", "run_id": "...", "commit": "..." },    // each may be null
  "generated_at": "<ISO time>" | null
}
```

## Schema: `web/receipts.json`

```
{
  "status": "pending" | "ok" | "failed",   // "ok": all 10 steps passed
  "network": "testnet",
  "token_account": "..." | null,
  "accounts": { "insider": "...", "late": "...", "wallets": ["w01...", ...] },
  "steps": [
    {
      "n": 1,                               // 1..10, sorted
      "title": "...",
      "ok": true,
      "expect": "...",
      "got": "...",                         // one line, human readable
      "txs": [
        {
          "hash": "<base58>" | null,
          "account": "<signer>",            // null for a faucet transaction whose signer the faucet did not name
          "outcome": "success" | "failure" | "invalid" | "unknown",
          "error": "<text>" | null
          // function calls only: "call": "<method>"   (buy, ft_transfer, storage_deposit, sell, shout, leave, hush)
          // only when the send was retried: "earlier_attempts": ["<hash>", ...]   (earlier broadcasts, oldest first)
          // after their lookup: "earlier_attempt_outcomes": [{ "hash", "outcome", "error" }]
          // only when a later lookup by hash confirmed an unconfirmed transaction: "resolved_late": true
          // step 9 only, a record made for an earlier broadcast that did execute: "retried_as": "<hash of the retry>"
          // step 9 only, one entry per leave call:
          // "round": 1, "exit_id": "3", "filled": "<units>" | null,
          // "error_code": "E_CAP" | "E_EXPIRED" | null, "block_timestamp": "<ns>" | null
          // calls that pay NEAR (step 7 sell, step 9 leaves):
          // "settled": true | false | null    (null: the call did not succeed, nothing was due)
          // when settled is false: "receipt_failures": 1, "receipt_error": "<text>" (a failed transfer and its payout_failed event count as 2)
        }
      ]
      // step 7 and 9 only: "payout_calls": 0 (successful paying calls), "payouts_settled": 0
      // step 9 only: "executed_failed": 0, "not_executed": 0, "unresolved": 0   (see "Outcomes")
      // step 2 only: "storage": { "expected_min", "min", "max", "unregistered_account", "unregistered_balance": null,
      //   "unregistered_is_registered": false, "creator_is_registered": true, "pass" }
      // step 4 and 7 only: "buy": { "attached", "registered_before", "expected_storage_paid", "expected_near_in",
      //   "pool_near_before", "pool_near_after", "pool_near_change", "event_near_in", "event_storage_paid", "pass" }
      //   step 7 adds "registered_after" and "storage_balance_total"
      // step 5 only: "balances": [{ "account", "loud", "quiet" }]
      // step 5 only: "unregistered_transfer": { "receiver", "registered_before", "amount", "hash", "outcome", "error_code", "pass" }
      // step 5 only: "registration": { "deposit", "wallets": 20, "registered": 20 }
      // step 8 only: "exits": [{ "id", "account", "amount", "ready_at", "expires_at" }]
      // step 8 only: "early_leave": { "account", "exit_id", "hash", "outcome", "error_code" }
      // step 8 only: "early_hush": { "account", "exit_id", "hash", "outcome", "error_code", "block_timestamp",
      //   "ready_at", "before_ready", "exit_still_open", "pass" }
    }
  ],
  "split": {
    "wallets": 20,
    "cap_units": "<units>" | null,
    "cap_window_ns": "<ns>" | null,
    "bucket_at_start": "<units>" | null,    // cap_available when the window started
    "window_start_ns": "<ns>" | null,
    "window_end_ns": "<ns>" | null,         // window_start_ns + cap_window_ns
    "measured_until_ns": "<ns>" | null,     // time of the closing get_state
    "sold_in_window": "<units>" | null,     // fills with block time <= window_end_ns
    "sold_total": "<units>" | null,         // change of total_left between the two get_state calls
    "bound": "<units>" | null,              // bucket_at_start + cap_units * (measured_until - window_start) / cap_window
    "attempts": 0,                          // leave calls sent
    "fills": 0,                             // leave calls that filled more than 0
    "cap_hits": 0,                          // leave calls rejected with E_CAP
    "receipts_match_counter": true | false | null,
    "measured_ns": "<ns>" | null,           // measured_until_ns - window_start_ns
    "full_window": true | false | null,     // measured_ns >= cap_window_ns
    "timestamps_valid": true | false | null, // every fill has a block time inside the measured interval
    "payout_calls": 0,                      // successful leave calls
    "payouts_settled": 0,                   // of those, calls without a failed receipt or payout_failed event
    "fail_reasons": ["..."] | null,         // empty when pass is true
    "pass": true | false,                   // all conditions of step 10, see above
    "executed_failed": 0 | null,            // leave calls that executed and failed (E_CAP, E_EXPIRED, other)
    "not_executed": 0 | null,               // leave calls refused before execution or never broadcast
    "unresolved": 0 | null                  // leave calls that were broadcast and whose outcome stayed unknown
  },
  "error": "<text>" | null,                 // set when the run stopped early
  "unresolved_txs": 0 | null,               // transactions the script sent whose outcome stayed unknown, all steps
  "unresolved_hashes": ["<hash>"] | null,
  "unresolved_note": "<text>" | null,       // one plain paragraph when unresolved_txs > 0, else null
  "token_near": {                           // NEAR of the token account, yoctoNEAR; each side is null if not read
    "at_deploy": { "balance", "pool_near", "owed_total", "spare", "storage_bytes": 0, "storage_stake", "free" } | null,
    "at_end": { ...same keys... } | null    // spare = balance - pool_near; free = spare - owed_total - storage_stake
  },
  "owed_total_at_end": "0" | null,          // get_state().owed_total after step 10
  "generated_at": "<ISO time>" | null
}
```

`outcome` values: `success` and `failure` were executed on chain (a `failure` has a hash that the explorer shows as failed); `invalid` was rejected before execution; `unknown` means no RPC endpoint confirmed the result. An `unknown` record with a hash is unresolved, not "not executed"; see "Outcomes" above. Every leave call is in exactly one group: in step 9, `payout_calls + executed_failed + not_executed + unresolved` equals `split.attempts`.

Explorer links: `https://testnet.nearblocks.io/txns/<hash>` and `https://testnet.nearblocks.io/address/<account>`.

The files in the repository start as placeholders with `"status": "pending"`. Keys are only ever added to the two files, never renamed or removed, so a file written by an earlier version of the script may lack the newer keys (`expected_code_hash`, `code_hash_match`, `params_match`, `param_mismatches`, `settled`, `payout_calls`, `payouts_settled`, `measured_ns`, `full_window`, `timestamps_valid`, `fail_reasons`, `executed_failed`, `not_executed`, `unresolved`, `unresolved_txs`, `unresolved_hashes`, `unresolved_note`, `earlier_attempts`, `earlier_attempt_outcomes`, `resolved_late`, `retried_as`, `call`, `storage`, `buy`, `unregistered_transfer`, `registration`, `early_leave`, `early_hush`, `token_near`, `owed_total_at_end`).

Step 5 holds 41 transactions in a run without retries: the refused transfer, 20 `storage_deposit` calls and 20 transfers. Step 8 holds 22: 20 shouts, the refused `leave` and the refused `hush`. The `call` key tells them apart.

A file written before the unresolved count existed has no `unresolved_txs` key, and its step 9 text puts the calls with the outcome `unknown` under "not executed" together with the `invalid` ones. By the grouping above, those with a hash are unresolved. A reader of such a file gets the same number by counting the records with `"outcome": "unknown"` and a hash that the script sent (in step 1, a record the faucet returned is not one of them). Such a file has no `earlier_attempts` either: a send that was retried is recorded with its last attempt only.
