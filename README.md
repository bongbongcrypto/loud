# LOUD

**A NEAR memecoin whose creator and launch buyers have to announce a sale before they make it. Splitting the bag across 100 wallets sells it no faster.**

- Live page: https://bongbongcrypto.github.io/loud/
- Testnet token: <!-- proof:token -->[t.loud-mwf63eou6bc318.testnet](https://testnet.nearblocks.io/address/t.loud-mwf63eou6bc318.testnet), no access keys, demo preset, recorded 2026-11-13<!-- /proof:token -->. Every transaction: [Testnet proof](https://bongbongcrypto.github.io/loud/#proof).
- Contract: [contracts/loud/src/lib.rs](contracts/loud/src/lib.rs). Exact rules and numbers: [SPEC.md](SPEC.md).

Built at NEAR HACKATHON, memecoins track. Testnet only. Unaudited.

## The problem

The creator and the launch buyers hold the cheap early supply. Most anti-dump rules limit each wallet, so an insider splits the bag across 100 wallets and sells all of it in the same minute. Everyone else finds out from the chart.

## How it works

1. Tokens bought during the launch window, and the creator allocation, are **loud**. Later buys are **quiet** and sell at once. The tag travels with the tokens through every transfer.
2. Loud tokens cannot be sold directly. The holder calls `shout`, which locks them and posts a public notice, then `leave` when the notice ends.
3. Every wallet's `leave` draws on one shared cap. More wallets never mean more room.
4. A shout cannot be cancelled. Tokens that are not sold stay locked for 90 min, and then `hush` returns them, still loud.
5. Every wallet but the creator's pays a one-time 0.02 NEAR storage fee. Nobody, the creator included, can change or pause the token: it has no owner method and its account has no access key.

Standard preset: 1,000,000,000 supply, 5% creator, launch window 10 min, notice 30 min, exit window 60 min, cap 0.5% of supply per 60 min.

LOUD limits how fast early supply can be sold on its defined path, no matter how many wallets it is split across. The path is the token's own pool, and every sale on it is public in advance. It does not stop a price from falling.

## Check it yourself

Run from the repository root. The Node rows need Node 22 or newer and nothing installed. The Rust rows need Rust 1.95.0 with the `wasm32-unknown-unknown` target.

| Do | See |
|---|---|
| `node --test web/*.test.mjs sim/*.test.mjs scripts/proof/*.test.mjs scripts/*.test.mjs` | All tests pass. Under LOUD, 1, 7, 20 and 100 wallets sell the same amount at every step, within rounding. Under a per-wallet limit, 100 wallets sell 100 times as much per minute as 1 while they still hold tokens. |
| `(cd contracts && cargo test --workspace)` | All tests pass. `split_test_one_wallet_vs_one_hundred` compares 1 wallet with 100. |
| `(cd contracts/loud && cargo near build non-reproducible-wasm --locked --no-abi)` with cargo-near 0.23.0 | One wasm of about 0.2 MB. [CI](.github/workflows/ci.yml) runs both Rust steps on every push. |
| Live page, "Run the split attack": run it with 1 wallet, then with 100 | The LOUD line stays the same. With more wallets the per-wallet rule sells the whole position sooner. |
| Live page, "Play the token by hand" | The same error codes the contract returns, such as `E_NO_QUIET` for selling loud tokens directly and `E_NOTICE` for leaving early. |
| `node sim/replay.mjs` | Writes `sim/REPLAY.md` again from the two measured sell schedules in `sim/replay-data/`. |
| Live page, "Testnet proof" | The token account, proof that nobody holds a key to it, and every recorded transaction on the explorer. The data is in [web/deployment.json](web/deployment.json) and [web/receipts.json](web/receipts.json); the steps are in [scripts/proof/README.md](scripts/proof/README.md). |
| `node sim/run.mjs` (about 2 min) | Writes `sim/results.json` and `sim/RESULTS.md` again, byte for byte the same. |
| `python3 -m http.server -d web 8000` | The same page at http://localhost:8000, served from static files with no build step. |

The testnet token runs a faster demo preset (launch window 2 min, notice 1 min, exit window 10 min, cap 0.5% per 10 min)<!-- proof:commit --> and was built from commit `845805a`, named in `deployment.json` as `run.commit`<!-- /proof:commit -->.<!-- proof:scope --><!-- /proof:scope -->

## What the track asked for

| Requirement | Where it shows |
|---|---|
| NEP-141 token | `ft_transfer`, `ft_transfer_call`, `ft_balance_of`, `ft_metadata` and NEP-145 `storage_deposit` in [contracts/loud/src/lib.rs](contracts/loud/src/lib.rs) |
| Mechanic lives in the contract | `shout`, `leave` and `hush` in the same file, tested by `cargo test --workspace` |
| Parameters fixed at launch and readable | Set once in `new`, no setter, read with `get_params` ([SPEC.md](SPEC.md) section 3) |
| No admin key | `access_keys` is empty in [web/deployment.json](web/deployment.json), and the contract has no owner method |
| Sybil limits stated | [Limits](#limits) below and [SPEC.md](SPEC.md) section 9 |
| Page with status and log | Live page: the exits board and "Testnet proof" |
| 60-day simulation under scenarios | [sim/RESULTS.md](sim/RESULTS.md), reproduced by `node sim/run.mjs` |

## Simulation

`node sim/run.mjs` runs the page's rule engine for 60 days against no rule and against a per-wallet limit: four scenarios, nine seeds each. How holders behave is assumed, not measured. Full tables and assumptions: [sim/RESULTS.md](sim/RESULTS.md).

Insiders dump 13.6% of supply from 30 wallets on day 1:

| Rule | Largest 1-hour price drop | Time to sell the early supply | Early-supply sales announced in advance | Holder's sell price 1 min in, vs before |
|---|---|---|---|---|
| No rule | 44.6% | at once | 0% | 61.9% |
| Per-wallet limit | 44.6% | at once | 0% | 61.9% |
| LOUD | 19.5% | 27.1 h | 100% | 100.0% |

LOUD does worse than no rule at all when nobody dumps. Its largest 1-hour drop is 14.0% against 11.0% in a calm launch and 14.0% against 10.7% in a slow bleed, because we assume holders rush out when they see a shout. With that rush set to zero the day-1 drop is 8.8%, and at three times the assumed rush it is 39.2%. A loose setting (2% per hour, 10 min notice) drops 44.2%, about the same as no rule.

Every number in this section comes from the simulation. The next section replays two real dumps.

## Replay of two real bundle dumps

Two pump.fun launches where a group of wallets bought early and sold everything within half an hour. Their sales were read from the chain and offered, minute by minute, to LOUD's standard rule in the same rule engine.

| Launch | | Bundle sold after 10 min | After 60 min | All sold after |
|---|---|---|---|---|
| Mint `7oE8o8kS6iyn5GyGhaBoi2HNz9M9m6n7VEdUWaxpump`, 2026-06-15. 4 wallets named in the [Bitquery report](https://bitquery.io/investigations/pump-fun-snipers-bundles). Measured: they bought 79.13% of supply in the creation block | on chain | 53.85% | 100.00% | 17.7 min |
| | LOUD | 0.00% | 0.63% | 158.9 h (6.6 days) |
| RKC, mint `7HgfXftRBBqsYtAEYcqjGLQrNJLL6Tww9ek4rE3Apump`, 2026-05-11. 10 wallets Lookonchain attributes to the developer ([post](https://x.com/lookonchain/status/2054007728872603911)). Measured: they bought 39.52% of supply within 184 s of launch | on chain | 90.03% | 100.00% | 29.9 min |
| | LOUD | 0.00% | 1.27% | 79.3 h (3.3 days) |

Under LOUD, holders in both cases also get 30 minutes of public notice before the first sale. The on-chain rows are measured. The LOUD rows are model output: a model pool, nobody else trading, and a bundle that bought inside the launch window, as both did. The RKC mint is derived from the wallets in the post. Full tables: [sim/REPLAY.md](sim/REPLAY.md), rebuilt by `node sim/replay.mjs`.

## Limits

- **Waiting out the launch window avoids the tag.** Someone who buys right after it gets quiet tokens with no notice and no cap. The creator allocation is always loud, and so are honest launch-window buyers.
- **Side deals.** Loud tokens can still be sent wallet to wallet, so private sales and wrapper contracts stay possible. The buyer's tokens are loud too.
- **A shout does not force a sale.** A holder can shout, sell nothing and take the tokens back after 90 min. The lock is the only cost.
- **A notice can trigger a rush.** Quiet holders can sell before a shouted exit is ready.
- **The creator allocation is unbacked.** It is minted without payment, so its proceeds come from buyers' NEAR. The last sellers may be unable to sell.
- **First come, first served.** There is no queue. One holder who keeps calling `leave` can take every refill and starve the others until their exits expire.
- **Sybil resistance.** The shared cap is the whole defence. The contract cannot tell people apart and offers no per-person fairness.

<details>
<summary>Contract-level limits</summary>

- **Other pools.** `ft_transfer_call` refuses loud tokens, so they cannot be deposited into a DEX. Other venues decide which quiet tokens they accept.
- **Small positions leave in one call.** Anything that fits in the cap room sells in a single `leave` after its notice. A full cap plus one refill lets out up to 1% of supply in an hour.
- **When the pool cannot pay.** `sell` fails with `E_POOL_EMPTY`, and `leave` fills only what the pool can pay.
- **Storage is never refunded.** There is no withdraw and no unregister. A transfer to an account that has not paid fails with `E_UNREGISTERED`. The payment covers five open exits; a sixth to eighth locks under 0.008 NEAR of the token account's balance until it closes.
- **Failed payouts.** A payout whose transfer fails is recorded and collected with `claim`. The record depends on a callback that can itself fail, and then nothing is recorded.
- **More than 100 open exits.** `get_exits` then pages in storage order, so a reader can skip or repeat an exit.
- **Not built.** There is no trading fee, no liquidity migration, no audit and no mainnet token.

</details>

## Layout

| Path | What |
|---|---|
| `contracts/loud-math` | Pool and cap integer math, no dependency. |
| `contracts/loud` | The token: NEP-141, the two balances, the built-in pool and the exits. |
| `web/engine.js` | The same rules in JavaScript, used by the page and the simulator. It keeps no registration and charges no storage. |
| `web/` | The static page, no build step. |
| `sim/` | The 60-day simulation, and the replay of two real launches with its data. |
| `scripts/proof` | The testnet run. |

## Libraries and AI use

- Contract: [near-sdk](https://github.com/near/near-sdk-rs) 5.30.1, the only external crate. Built with cargo-near 0.23.0 on Rust 1.95.0.
- Proof run: [near-api-js](https://github.com/near/near-api-js) 5.1.1 for keys and signing, used only by the testnet run.
- Page, engine, simulator and RPC client: no dependency.
- The code, tests and text were written with Claude Code, an AI coding tool, directed and checked by the author.

## License

MIT, see [LICENSE](LICENSE).
