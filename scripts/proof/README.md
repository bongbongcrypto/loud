# Proof run

`proof.mjs` deploys LOUD to NEAR testnet and runs the checks of SPEC section 8 against the live contract. It writes two files that the web page reads:

- `web/deployment.json`: where the token lives and whether its account has zero access keys.
- `web/receipts.json`: every step, with transaction hashes.

It runs only in GitHub Actions (`.github/workflows/proof.yml`, manual trigger). All keys are generated in memory inside the job and are never written to disk or to the log. Nothing here needs a secret.

## What it does

The step numbers are the ones used in `receipts.json`. Step 3 runs before step 2 so that the 2 minute loud window is not spent on account creation.

| n | Step | Expectation |
|---|---|---|
| 1 | Create a fresh root account `loud-<random>.testnet` through the testnet faucet | account exists and holds enough NEAR |
| 2 | Create `t.<root>` in one batch transaction: CreateAccount, Transfer, DeployContract, FunctionCall `new` (demo preset, creator = insider). No AddKey | `view_access_key_list` is empty |
| 3 | Create `insider`, `w01`..`w20` and `late` under the root | 22 accounts |
| 4 | The insider buys with 1 NEAR in the loud window | bought tokens are loud |
| 5 | The insider splits its whole loud balance across the 20 wallets with `ft_transfer` | every wallet holds loud, no quiet |
| 6 | One wallet calls `sell()` | fails with `E_NO_QUIET` |
| 7 | After the loud window the late buyer buys with 0.5 NEAR and sells half | holds quiet only, sell succeeds |
| 8 | All 20 wallets `shout` their full balance; one calls `leave()` at once | 20 open exits, the leave fails with `E_NOTICE` |
| 9 | After the notice all 20 wallets call `leave()` in rounds for one full cap window | at least one fill; rejected calls fail with `E_CAP` (or `E_EXPIRED` at the end) |
| 10 | Compare what left with the cap | `sold_total <= bucket_at_start + cap_units * elapsed / cap_window_ns` (SPEC invariant 4) |

Notes on step 9 and 10:

- The cap bucket refills continuously, so a call that lands alone in a block usually fills a small amount. `E_CAP` shows up when several calls land in the same block. All 20 wallets send in the same round every `ROUND_SECONDS` (default 20); a wallet that hits `E_CAP` sends again in the next round.
- `bucket_at_start` and `window_start_ns` come from one `get_state` call after the last notice ended. `sold_total` is the change of the contract counter `total_left`; the per-transaction fills are the evidence, and `receipts_match_counter` says whether the two agree.
- The exits expire one exit window after their notice ended, which in the demo preset is the same length as the cap window, so the last round can end with `E_EXPIRED`.

Scope of the split test: SPEC section 8.1 describes scenario A (one account alone) and scenario B (split across N accounts). This run executes scenario B only, with N = 20. The cap is global per token, so A cannot run on the same token in the same window. Step 10 checks the total against the invariant 4 bound, which does not depend on the number of accounts. A == B is checked in the contract unit test (N = 100) and in the engine tests (`web/engine.test.mjs`, 1 vs 100 wallets).

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
| `MAX_RUNTIME_MINUTES` | `24` | the script stops and writes its files after this |

`rpc.testnet.near.org` is not the first RPC because the NEAR docs (docs.near.org/api/rpc/providers) list the near.org endpoints as severely rate limited, and this run sends several hundred transactions.

If one faucet grant is smaller than the run needs, the script creates up to three more faucet accounts and deletes each with the root as beneficiary.

## Files

| File | Role |
|---|---|
| `proof.mjs` | the run |
| `rpc.mjs` | JSON-RPC client with failover, no dependencies |
| `lib.mjs` | pure helpers (amounts, budget, error codes, the cap bound) |
| `lib.test.mjs` | `node --test` for `lib.mjs`; runs in CI |
| `package.json` | one pinned dependency, `near-api-js` 5.1.1, used for keys, actions and borsh encoding. Installed in Actions with `npm install --ignore-scripts` |

## Schema: `web/deployment.json`

All token and NEAR amounts and all nanosecond timestamps are decimal strings.

```
{
  "status": "pending" | "ok" | "failed",   // "ok": deployed and zero_keys is true
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
  "code_hash": "<base58>" | null,
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
          "account": "<signer>",
          "outcome": "success" | "failure" | "invalid" | "unknown",
          "error": "<text>" | null
          // step 9 only, one entry per leave call:
          // "round": 1, "exit_id": "3", "filled": "<units>" | null,
          // "error_code": "E_CAP" | "E_EXPIRED" | null, "block_timestamp": "<ns>" | null
        }
      ]
      // step 5 only: "balances": [{ "account", "loud", "quiet" }]
      // step 8 only: "exits": [{ "id", "account", "amount", "ready_at", "expires_at" }]
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
    "pass": true | false                    // sold_total > 0, sold_total <= bound, sold_in_window <= bucket_at_start + cap_units
  },
  "error": "<text>" | null,                 // set when the run stopped early
  "generated_at": "<ISO time>" | null
}
```

`outcome` values: `success` and `failure` were executed on chain (a `failure` has a hash that the explorer shows as failed); `invalid` was rejected before execution; `unknown` means no RPC endpoint confirmed the result.

Explorer links: `https://testnet.nearblocks.io/txns/<hash>` and `https://testnet.nearblocks.io/address/<account>`.

The files in the repository start as placeholders with `"status": "pending"` and the same keys.
