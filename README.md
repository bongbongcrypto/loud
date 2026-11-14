# LOUD

**A NEAR memecoin where launch tokens have to shout before they sell, and the room can answer.**

LOUD makes launch supply announce its exit. The creator allocation and the tokens bought in the launch window are *loud*. They sell into the token's own pool only after a public notice, and every wallet draws on one shared cap, so splitting a bag across 100 wallets adds no room. While a notice is up, anyone else can *catch* the exit: buy the tokens from the seller, for no less than the pool's price when the exit was shouted, and take them, still loud, so that sale never hits the pool. Tokens bought later are *quiet* and sell at once. That includes tokens a holder sells through the cap and then buys back: the cap sets how fast early supply can be sold into the pool or converted, and it does not stop a price from falling ([Limits](#limits)).

- **Use it now, no wallet needed:** https://bongbongcrypto.github.io/loud/#try. One click gives you a funded NEAR testnet account inside the page. Buy, get refused on `sell`, shout, catch from a second wallet, leave. Each of those is a real transaction with an explorer link.
- Live token to try: [t.loud-live-mwg2oscvef9c57.testnet](https://testnet.nearblocks.io/address/t.loud-live-mwg2oscvef9c57.testnet), no access keys, launch window open until 2026-11-21 so every visitor's buy is loud.
- Live page: https://bongbongcrypto.github.io/loud/
- Testnet token: <!-- proof:token -->[t.loud-mwfw1nxp3572b6.testnet](https://testnet.nearblocks.io/address/t.loud-mwfw1nxp3572b6.testnet), no access keys, demo preset, recorded 2026-11-14<!-- /proof:token -->. Every transaction: [Testnet proof](https://bongbongcrypto.github.io/loud/#proof).
- Contract: [contracts/loud/src/lib.rs](contracts/loud/src/lib.rs). Exact rules and numbers: [SPEC.md](SPEC.md).

Built at NEAR HACKATHON, memecoins track. Testnet only. Unaudited.

## Use it on testnet

The page's "Use it on testnet" section, right after the simulated exits board at the top, talks to the live token directly. There is no backend and no wallet extension.

1. **Get a test wallet.** The page makes a key pair in your browser and asks the public NEAR testnet faucet for a funded account. The key stays in that browser's storage. It is a throwaway and holds no real funds.
2. **Buy** with 2 NEAR. The launch window of this token is open until 2026-11-21, so the tokens arrive loud.
3. **Sell.** The contract refuses: `E_NO_QUIET`.
4. **Shout.** After the buy the page fills in the wallet's whole loud balance. Your exit appears on the board that every visitor sees. Try **Hush**: refused, `E_NOTICE_BINDING`.
5. **Get a second wallet**: the page makes it from your first wallet with 3 of its test NEAR, in one transaction, so the faucet is asked only once. **Catch quarter** of your own exit from it. The tokens arrive loud and the pool sells nothing.
6. Switch back, wait out the 1 min notice and **Leave**. When what is left of the exit is larger than the room in the shared cap, `leave` sells part of it; the result line says how much, and whether the cap or the pool's NEAR set the limit.

The live token runs a demo setting: launch window 7 days (the longest the contract allows), notice 1 min, exit window 30 min, cap 0.5% of supply per 10 min, no creator allocation. So nobody holds quiet tokens on it yet. It was deployed by [a workflow](.github/workflows/live.yml); the deployment is recorded in [web/live.json](web/live.json). Transactions are signed by [web/chain.js](web/chain.js), which has no dependency: Ed25519 from the browser's WebCrypto, its own transaction encoding, checked byte for byte against near-api-js in CI. It needs a current Chrome, Edge, Firefox or Safari. An existing testnet account can be imported with its private key (throwaway testnet accounts only); connecting a wallet app is not built.

## What happened on testnet

A script put the token on NEAR testnet and attacked it with 20 split wallets. Each row links a transaction of that run, on a faster demo preset (notice 1 min, cap window 10 min). The split took 20 transfers and one is linked. The last row adds up every `leave` call of the cap window.

| What was tried | What the contract did | Transaction |
|---|---|---|
| Create, fund, deploy and initialise the token account in one transaction that adds no key | Done. The account has 0 access keys, so nobody can sign for it | [3rNaaZ…](https://testnet.nearblocks.io/txns/3rNaaZtEQBE95vxmqExXGEeUrssebfXSzLbkKWePHpDn) |
| The insider splits its launch tokens across 20 wallets with `ft_transfer` | Done. The tokens arrive still loud, as the next row shows | [AaTyvH…](https://testnet.nearblocks.io/txns/AaTyvHo1jgJfMyaiPUd9S2j9oydeDDsuWhm3r5ZPeZLG) |
| A split wallet calls `sell` with those tokens | Rejected: `E_NO_QUIET` | [3waXwA…](https://testnet.nearblocks.io/txns/3waXwAgDHau6XDGULMQ2MZaXxTACCyRn48JuRFWuBo9W) |
| The wallet shouts, then calls `leave` 57 s before its notice ends | Rejected: `E_NOTICE` | [4UHzj6…](https://testnet.nearblocks.io/txns/4UHzj6QkWLU1vznfX2LTAGUC46Gn54t94XQbzrftmn9K) |
| The same wallet tries to take the shout back with `hush` | Rejected: `E_NOTICE_BINDING` | [Fe6zF2…](https://testnet.nearblocks.io/txns/Fe6zF2igoF1HVuPu9dbRBAzxtsSH6ufHid3cnU395T4a) |
| Another wallet tries to catch its own exit | Rejected: `E_SELF` | [5xHRU1…](https://testnet.nearblocks.io/txns/5xHRU16n6ZRqz8CuGM5BYcsxNxVshk9GwHZsP6pM7j7t) |
| A late buyer catches a quarter of that exit while the notice is still up | Paid 0.0211 NEAR and got 2,604,166 LOUD, still loud. The pool sold nothing, kept the 1% fee, and the cap was not used | [DVdwSM…](https://testnet.nearblocks.io/txns/DVdwSMPa55767UfJeC2QkewndXFVSWAN5JHCYjHLvBgX) |
| After the notice, a wallet calls `leave` while the cap has room | Sold 1,637,413 LOUD | [83o4MK…](https://testnet.nearblocks.io/txns/83o4MKSNxZkr53crq6htWt36GrfkNWnsNKkDXDERpFu4) |
| Another wallet calls `leave` when the cap is empty | Rejected: `E_CAP` | [9YRMyL…](https://testnet.nearblocks.io/txns/9YRMyLWMQd9LjQVc4nT7ayKKgL9V2t6MA6876h4yZyPu) |
| All 20 wallets keep calling `leave` for 605 s, one cap window and the calls still in flight, 620 calls | 37 sales, 563 `E_CAP` rejections, 20 `E_EXPIRED` once the exit window had closed. 6,498,658 LOUD got out; the cap allowed at most 6,649,928 in that time | [receipts.json](web/receipts.json) |

The run shows 20 wallets staying inside one cap on chain. That 1 wallet and 100 wallets sell the same amount on the standard preset is shown by the contract and engine tests, not by this run. Ten checks, every transaction: [Testnet proof](https://bongbongcrypto.github.io/loud/#proof).

## The problem

The creator and the launch buyers hold the cheap early supply. A per-wallet sell limit caps each wallet, so an insider splits the bag across 100 wallets and sells all of it in the same minute. Everyone else finds out from the chart. On one pump.fun launch, four wallets bought 79% of the supply in the creation block and sold all of it in 18 minutes ([replay below](#replay-of-two-real-bundle-dumps)).

## How it works: shout, wait, leave

No loud token reaches the pool quietly. Every sale of loud tokens into the pool goes up on a public departures board first.

1. Tokens bought during the launch window, and the creator allocation, are **loud**. Later buys are **quiet** and sell at once. The tag travels with the tokens through every transfer.
2. Loud tokens cannot use `sell`. To sell into the pool the holder calls `shout`, which locks them and posts a public notice, then `leave` when the notice ends.
3. Every wallet's `leave` draws on one shared cap. More wallets never mean more room.
4. The owner's account cannot cancel a shout. The tokens stay locked until they are sold, caught, or the exit ends, and then `hush` returns what is left, still loud.
5. From the moment of the shout until the exit ends, any other registered account can call `catch` on it with NEAR attached. The price is the higher of the pool formula's sell quote now and its quote when the exit was shouted (the formula's figure, whether or not the pool holds enough NEAR to pay it), so a catch never costs less than the same share of what the pool would have paid for the whole exit when it was shouted. The catcher receives the tokens as loud. Of the price, 1% stays in the pool and the seller gets the rest. The pool sells nothing and the cap is not used, so an exit that is fully caught never pushes the price down. Holders who believe in the coin can take an announced exit off the board before it reaches the pool, and what they catch is as loud as it was: to sell it they must shout too.
6. Every wallet but the creator's needs a one-time 0.03 NEAR storage fee. Nobody, the creator included, can change or pause the token: it has no owner method and its account has no access key.

Standard preset: 1,000,000,000 supply, 5% creator, launch window 10 min, notice 30 min, exit window 60 min, cap 0.5% of supply per 60 min. The cap is a bucket that holds 0.5% and refills 0.5% per 60 min, so a full bucket plus one refill lets at most 1% into the pool through `leave` in any 60 min. Quiet sales are not counted.

What a launch buyer accepts:

- The rule does not know who is an insider. An honest launch-window buyer shouts and waits like everyone else.
- A shout locks the tokens until they sell, someone catches them, or the exit expires, 90 min after the shout on the standard preset. After that `hush` returns them. The owner cannot refuse a catch at or above the floor.
- The cap is first come, first served. A `leave` fills only what the cap and the pool have room for.
- Anyone who wants no part of this buys after the launch window and holds quiet tokens.

What everyone else can do: watch the board, and when a shout goes up, sell first, hold, or catch it. Every shout is a public question to the room, and catching is the answer that keeps that sale out of the pool.

## Check it yourself

Run from the repository root. The Node rows need Node 22 or newer and nothing installed. The Rust rows need Rust 1.95.0 with the `wasm32-unknown-unknown` target.

| Do | See |
|---|---|
| `node --test web/*.test.mjs sim/*.test.mjs scripts/proof/*.test.mjs scripts/*.test.mjs` | All tests pass. Under LOUD on the standard preset, 1, 7, 20 and 100 wallets sell the same amount at every step, within rounding. Under a per-wallet limit, 100 wallets sell 100 times as much per minute as 1 when each holds enough to use its whole limit; the test uses a 50% position. A 5% position is gone in 1 minute against 10. |
| `(cd contracts && cargo test --workspace)` | All tests pass. `split_test_one_wallet_vs_one_hundred` compares 1 wallet with 100. |
| `(cd contracts/loud && cargo near build non-reproducible-wasm --locked --no-abi)` with cargo-near 0.23.0 | One wasm of about 0.2 MB. [CI](.github/workflows/ci.yml) runs both Rust steps on every push. |
| Live page, "Run the split attack": run it with 1 wallet, then with 100 | The LOUD line stays the same. With more wallets the per-wallet rule sells the whole position sooner. |
| Live page, "Use it on testnet" | Real transactions on the live token from a test wallet made in the page, each with an explorer link. |
| Live page, the simulator ("play the rule by hand") | The same error codes the contract returns, such as `E_NO_QUIET` for selling loud tokens directly and `E_NOTICE` for leaving early. |
| `node sim/replay.mjs` | Writes `sim/REPLAY.md` again from the two measured sell schedules in `sim/replay-data/`. |
| Live page, "Testnet proof" | The token account, proof that nobody holds a key to it, and every recorded transaction on the explorer. The data is in [web/deployment.json](web/deployment.json) and [web/receipts.json](web/receipts.json); the steps are in [scripts/proof/README.md](scripts/proof/README.md). |
| `node sim/run.mjs` (about 2 min) | Writes `sim/results.json` and `sim/RESULTS.md` again, byte for byte the same. |
| `python3 -m http.server -d web 8000` | The same page at http://localhost:8000, served from static files with no build step. |

The testnet token runs a faster demo preset (launch window 2 min, notice 1 min, exit window 10 min, cap 0.5% per 10 min)<!-- proof:commit --> and was built from commit `a727bf2`, named in `deployment.json` as `run.commit`<!-- /proof:commit -->.<!-- proof:scope --><!-- /proof:scope --> The testnet run shows 20 wallets staying inside the cap. The unit and engine tests show that 1 wallet and 100 wallets sell the same amount.

## The track prompt, item by item

The mechanic is `shout`, `leave`, `hush` and `catch`. The table maps each item of the memecoins track prompt to where it can be checked.

| Prompt item | Where it shows |
|---|---|
| NEP-141 token | `ft_transfer`, `ft_transfer_call`, `ft_balance_of`, `ft_metadata` and NEP-145 `storage_deposit` in [contracts/loud/src/lib.rs](contracts/loud/src/lib.rs) |
| Mechanic lives in the contract | `shout`, `leave`, `hush` and `catch` in the same file, tested by `cargo test --workspace` |
| Parameters fixed at launch and readable | Set once in `new`, no setter, read with `get_params` ([SPEC.md](SPEC.md) section 3) |
| No admin key | `access_keys` is empty in [web/deployment.json](web/deployment.json), and the contract has no owner method |
| Sybil limits stated | [Limits](#limits) below and [SPEC.md](SPEC.md) section 9 |
| Page with status and log | Live page: the exits board and "Testnet proof" |
| 60-day simulation under scenarios | [sim/RESULTS.md](sim/RESULTS.md), reproduced by `node sim/run.mjs` |

## Splitting adds no room

This is the claim the tests pin down. Splitting cannot enlarge the shared cap, under any parameters. On the standard preset that means 1, 7, 20 and 100 wallets holding the same position sell the same amount at every step, within rounding: `split_test_one_wallet_vs_one_hundred` in the contract tests, and the same comparison in the engine tests. Under a per-wallet limit the same split sells a 5% position in 1 minute against 10. The live page runs it with up to 1000 wallets. What a group actually sells under the cap can still differ with other parameters: an account has eight exit slots, so with a very short exit window one wallet can use less of the cap than many.

## Simulation

`node sim/run.mjs` runs the page's rule engine for 60 days: three rule sets, four scenarios, nine seeds each. The sale budgets are not matched. The per-wallet baseline (0.5% of supply per sale, one sale per wallet per 60 s) lets even one wallet sell far faster than the LOUD cap, so the price figures below mix a tighter budget, the notice and assumed holder reactions. They do not isolate what the shared cap adds; the split tests above do that. How holders behave is an assumption. Nobody measured it. Nobody catches in the simulation, so it says nothing about catching. Full tables and assumptions: [sim/RESULTS.md](sim/RESULTS.md).

Modelled scenario: at hour 24, 30 insider wallets try to sell 13.6% of supply.

| Rule | Largest 1-hour price fall after the first 12 hours | Time until the modelled seller has sold 99.9% of early supply | Early-supply sales announced in advance | Holder quote 1 min after the first sign | Worst holder quote within 30 min |
|---|---|---|---|---|---|
| No rule | 44.6% | at once | 0% | 61.9% | 58.9% |
| Per-wallet limit | 44.6% | at once | 0% | 61.9% | 58.9% |
| LOUD | 19.5% | 27.1 h | 100% | 100.0% | 84.9% |

Each cell is the median of 9 seeds. The holder quote is the price for selling 0.01% of supply, as a share of the price just before the first sign. When the pool cannot pay for all of it, the quote covers only the part it can pay. That sign is the first shout under LOUD and the first sale under the other rules. Nobody in the run makes that sale. The announced column is 100% under LOUD by construction. The LOUD seller goes through the notice and the cap and does not buy back.

Standard LOUD does worse than no rule when early supply does not dump. By the same 1-hour measure it falls 14.0% against 11.0% in a calm launch, where the modelled insider group never sells, and 14.0% against 10.7% in a slow bleed, where it sells a twentieth a day. Ordinary launch-window buyers still sell through exits in both. In the calm launch the cause is an assumption: holders rush out when they see a shout. With that rush set to zero the day-1 dump scenario gives 8.8%, and at three times the assumed rush 39.2%. A loose setting (2% per hour, 10 min notice) gives 44.2%, about the same as no rule.

Every number in this section comes from the simulation. The next section replays two real dumps.

## Replay of two real bundle dumps

Two pump.fun launches where a group of wallets bought early and sold everything within half an hour. Their sales were read from the chain and offered, minute by minute, to LOUD's standard rule in the same rule engine. The LOUD rows are a what-if on the sell schedule. They say how fast the tokens could have left, not what holders would have lost or kept.

| Launch | | Bundle sold after 10 min | After 60 min | All sold after |
|---|---|---|---|---|
| Mint `7oE8o8kS6iyn5GyGhaBoi2HNz9M9m6n7VEdUWaxpump`, 2026-06-15. 4 wallets named in the [Bitquery report](https://bitquery.io/investigations/pump-fun-snipers-bundles). Measured: they bought 79.13% of supply in the creation block | on chain | 53.85% | 100.00% | 17.7 min |
| | LOUD | 0.00% | 0.63% | 158.9 h (6.6 days) |
| RKC, mint `7HgfXftRBBqsYtAEYcqjGLQrNJLL6Tww9ek4rE3Apump`, 2026-05-11. 10 wallets Lookonchain attributes to the developer ([post](https://x.com/lookonchain/status/2054007728872603911)). Measured: they bought 39.52% of supply within 184 s of launch | on chain | 90.03% | 100.00% | 29.9 min |
| | LOUD | 0.00% | 1.27% | 79.3 h (3.3 days) |

Under LOUD, holders in both cases also get 30 minutes of public notice before the first sale. The on-chain rows are measured. The LOUD rows are model output: a model pool, nobody else selling, and a bundle that bought inside the launch window, as both did. The replay assumes the bundle sells through the notice and the cap and does not buy back. The RKC mint is derived from the wallets in the post. Full tables: [sim/REPLAY.md](sim/REPLAY.md), rebuilt by `node sim/replay.mjs`.

## Limits

- **Leave, then buy back.** Once the launch window is over, a holder can sell loud tokens through the notice and the cap and, in the same transaction, buy the same amount back with NEAR of their own. The pool ends where it started, within rounding, and the holder now owns quiet tokens, which sell with no notice and no cap. So the cap sets how fast early supply can be sold or converted. It does not stop a later dump of tokens bought back at the market price. Every conversion still shows on chain as a shout and a leave.
- **A standing notice.** A holder can keep exits open one after another, so some exit is always ready. The notice then says a sale may come, with no exact time.
- **Side deals and wrappers.** Loud tokens can be sent with a plain transfer to another registered account. That covers a private sale, and it covers a contract that issues its own token against them. Whoever buys that wrapper token holds no tag.
- **Waiting out the launch window avoids the tag.** Someone who buys right after it gets quiet tokens with no notice and no cap. The creator allocation starts loud, and so do the tokens of honest launch-window buyers.
- **A shout does not have to end in a pool sale.** A holder can shout, sell nothing and take the tokens back after the exit expires, at no cost beyond gas and the lock. A second account of the same holder can take them back sooner by catching the exit, for the 1% fee. So a shout can be a bluff: shout, let others sell first, take it back.
- **The seller sets the catch price floor.** The floor is the pool's price for the shouted amount at the moment of the shout, and it never comes down. A seller who does not want to be caught can lift the pool price for an instant around their own shout and so set a floor nobody will pay. After a real price fall, a catch can cost more than the pool pays, and then there is little reason to catch. Someone who sells just before a shout lands lowers the floor it records.
- **A notice can trigger a rush.** Quiet holders can sell before a shouted exit is ready.
- **Catching is a cash-out the cap does not slow.** A seller whose exit is caught has the payment sent in the same call, however large it is. The pool sells nothing, its price moves only by the 1% fee it keeps, and the supply stays loud in the catcher's hands, but an insider with a willing buyer leaves faster than the cap. A holder can also take back their own shout by catching it from a second wallet. That costs the 1% fee and only moves loud tokens between their wallets. Catchers take on tokens they must shout to sell, while quiet holders stay free to sell. A `leave` can fail with `E_SLIPPAGE` or `E_NO_EXIT` if someone catches from the exit just before it.
- **The creator allocation is unbacked.** It is minted without payment, so its proceeds come from buyers' NEAR. The last sellers may be unable to sell.
- **First come, first served.** There is no queue. One holder who keeps calling `leave` can take every refill and starve the others until their exits expire.
- **Sybil resistance.** The shared cap is the whole defence. More accounts add no room under it. They do add exit slots, eight per account. The contract cannot tell people apart and offers no per-person fairness.

<details>
<summary>Contract-level limits</summary>

- **Other pools.** `ft_transfer_call` refuses loud tokens. Quiet tokens can be sent with it. The receiving contract gets a fixed 30 Tgas for its `ft_on_transfer`, and if that is not enough the contract takes the tokens back, up to the quiet balance the receiver still holds.
- **Small positions leave in one call.** What fits the cap room sells in one `leave` after notice if the pool can pay. A full cap plus one refill lets out up to 1% of supply in an hour.
- **When the pool cannot pay.** `sell` fails with `E_POOL_EMPTY`, and `leave` fills only what the pool can pay.
- **The 0.03 NEAR storage fee is never refunded.** A `storage_deposit` above it is refunded at once. On a first buy the fee comes out of the attached NEAR and the rest buys tokens. There is no withdraw and no unregister. A transfer to an unregistered account fails with `E_UNREGISTERED`. The 0.03 NEAR covers the account's records and eight open exits, the most one account can have.
- **Failed payouts.** A payout whose transfer fails is recorded and collected with `claim`. The record depends on a callback that can itself fail, and then nothing is recorded.
- **More than 100 open exits.** `get_exits` then pages in storage order, so a reader can skip or repeat an exit.
- **Not built.** There is no trading fee beyond the 1% catch fee, no liquidity migration, no audit and no mainnet token.

</details>

## Layout

| Path | What |
|---|---|
| `contracts/loud-math` | Pool and cap integer math, no dependency. |
| `contracts/loud` | The token: NEP-141, the two balances, the built-in pool and the exits. |
| `web/engine.js` | The same rules in JavaScript, used by the page and the simulator. It leaves out account registration, the 0.03 NEAR storage payment, asynchronous payouts and `ft_transfer_call` refunds. Its views differ in small ways: a quote that overflows throws instead of returning 0, the state has no `cap_full_ts`, and exits page in insertion order. |
| `web/chain.js` | The page's NEAR client: test wallets from the faucet or from another wallet, signing, sending (a send whose answer is lost is looked up by hash, never signed again), RPC. No dependency. |
| `web/live-ui.js`, `web/live.json` | The "Use it on testnet" section and the record of the live token. |
| `web/` | The static page, no build step. |
| `sim/` | The 60-day simulation, and the replay of two real launches with its data. |
| `scripts/proof` | The testnet run. |

## Libraries and AI use

- Contract: [near-sdk](https://github.com/near/near-sdk-rs) 5.30.1, the only direct external crate. Built with cargo-near 0.23.0 on Rust 1.95.0.
- Proof run: [near-api-js](https://github.com/near/near-api-js) 5.1.1 for keys and signing, used only by the testnet run.
- Page, engine, simulator and RPC client: no dependency.
- The code, tests and text were written with Claude Code, an AI coding tool, directed and checked by the author.

## License

MIT, see [LICENSE](LICENSE).
