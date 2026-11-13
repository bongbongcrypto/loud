# LOUD

**A memecoin whose early supply can leave, but cannot leave quietly, and cannot leave faster by splitting it across wallets.**

That sentence is about the token's built-in sale path. On that path the contract enforces two things: a public notice before every sale of early supply, and one shared bucket that bounds how much of it can leave over time. Plain transfers and off-pool deals stay possible (see [Limits](#limits)), and a position smaller than the room in the bucket can leave in one call once its notice is over.

Built at NEAR HACKATHON, memecoins track. Testnet only. Unaudited.

- Live page: https://bongbongcrypto.github.io/loud/
- Rules, names and numbers: [SPEC.md](SPEC.md) (single source of truth)
- Contract: [contracts/loud/src/lib.rs](contracts/loud/src/lib.rs)

## The problem

Launch buyers and the creator hold the early supply. Common anti-dump rules limit each wallet or each transaction, so an insider splits the bag across 100 wallets and sells 100 bags at once. Holders learn about it from the chart.

## The rule

Every balance has two parts, `loud` and `quiet`.

1. Tokens bought during the launch window, and the creator allocation, are **loud**. The tag follows the tokens through every transfer; it is not attached to the wallet.
2. Loud tokens cannot be sold with `sell` and cannot enter another contract with `ft_transfer_call`. On the contract's sale path their one way out is the door: `shout` (tokens go to escrow, a public notice starts) then, after the notice period, `leave` (sell into the built-in pool).
3. All leaves of all accounts draw from **one bucket owned by the token**. It holds at most `cap` and refills `cap` per window. More wallets never mean more room.
4. Tokens sold through the door go back into the pool. Anyone who buys after the launch window gets **quiet** tokens. Quiet tokens are exempt from the notice and the cap: they can be sold with `sell` at once and can use `ft_transfer_call`. The built-in pool can still refuse a sale it cannot pay, and other venues decide for themselves what they accept (see [Limits](#limits)). A purchase during the launch window is always loud: in a preset where an exit can become ready inside the launch window (notice shorter than the launch window, as in the `demo` preset), tokens that left through the door are loud again when bought in that window.
5. No owner, no admin method, no access key on the token account. Parameters are fixed in `new` and readable with `get_params`.

Standard preset: 1,000,000,000 supply, 5% creator, launch window 10 min, notice 30 min, exit window 60 min, cap 0.5% of supply per 60 min.

What "cap 0.5% per 60 min" means exactly: the bucket never holds more than 0.5% and refills 0.5% per 60 min. A single 60 minutes can therefore let out at most the room already in the bucket plus one refill (at most 1%), and the long-run rate is 0.5% per hour (SPEC 4, invariant 4).

The claim is narrow on purpose: LOUD **limits the sell speed of early supply on the defined path and makes every such sale public in advance**. It does not stop a price from falling and it does not identify insiders.

## Check it yourself

Each row is something to do and what you should see. Node 22 or newer; the JS has no install step.

| Do | See |
|---|---|
| `node --test web/*.test.mjs sim/*.test.mjs scripts/proof/*.test.mjs` | 70 tests pass. Among them: under LOUD, 1, 7, 20 and 100 wallets sell the same cumulative amount at every step; under a per-wallet limit, 100 wallets sell 100 times more in the first minute than 1 wallet. |
| `cd contracts && cargo test --workspace` (Rust 1.95.0) | 63 tests pass (40 contract, 23 math). `split_test_one_wallet_vs_one_hundred` compares 1 wallet with 100 wallets at 21 checkpoints. `cargo test -p loud split -- --nocapture` prints the table. |
| `cd contracts/loud && cargo near build non-reproducible-wasm --no-abi` (cargo-near 0.23.0) | One wasm, about 220 KB. CI runs both Rust steps on every push: [.github/workflows/ci.yml](.github/workflows/ci.yml). |
| Open the live page, section "Run the split attack", run it with 1 wallet and then with more | The LOUD line does not change. With more wallets the per-wallet baseline sells the whole position sooner, until it is gone in the first minute; for the default 5% position that point is already reached at 10 wallets. |
| Section "Play the token by hand", follow the guided path | The real error of each rule: `E_NO_QUIET` (selling loud tokens), `E_NOTICE` (leaving early), `E_CAP` (bucket empty), `E_EXPIRED`. |
| Section "Testnet proof" | The token account, its zero access keys, and every transaction the run itself sent, with explorer links. The faucet's own account-creation transaction (step 1) is listed only if the faucet returned its hash. In the saved run it is listed: `web/receipts.json` step 1 holds that hash with the outcome `success`, both recorded as the faucet returned them (the script does not look that transaction up). |
| `node sim/run.mjs` (about 2 min) | Rewrites `sim/results.json` and `sim/RESULTS.md` byte for byte (LF checkout; `.gitattributes` sets LF line endings). |

The page (`web/`) is static files with no dependency and no build step. Serve the folder with any static server, for example `python -m http.server -d web 8000`, and open http://localhost:8000.

## Testnet proof

`.github/workflows/proof.yml` (manual trigger) builds the same wasm as CI and runs [scripts/proof/proof.mjs](scripts/proof/proof.mjs) against NEAR testnet. All keys are generated inside the job and never stored. The result is committed to `web/deployment.json` and `web/receipts.json` and shown on the page.

The ten steps, numbered as in `web/receipts.json`. The script runs step 3 before step 2: it creates the participant accounts before it deploys the token, so that the launch window is not spent on setup.

1. Create a fresh root account through the testnet faucet.
2. Create, fund, deploy and initialise the token account in one transaction that adds no access key. The run then reads the key list and expects it to be empty.
3. Create an insider, 20 split wallets and a late buyer (done before step 2).
4. The insider buys during the launch window: its tokens are loud.
5. The insider splits its loud balance across 20 wallets with `ft_transfer`: every wallet's balance is still loud.
6. A split wallet calls `sell`: fails with `E_NO_QUIET`.
7. After the launch window a late buyer buys and sells half at once: quiet tokens need no notice and no cap room.
8. All 20 wallets `shout`; one calls `leave` before the notice ends: fails with `E_NOTICE`.
9. All 20 wallets call `leave` in rounds for one full cap window. Rejected calls fail with `E_CAP`, or with `E_EXPIRED` at the very end of the exit window.
10. Total units that left stay within `room at start + cap * elapsed / window`.

The run uses the `demo` preset (launch window 2 min, notice 1 min, exit window 10 min, cap 0.5% per 10 min) so that it fits in one CI job. The on-chain run is the 20-wallet case only: the cap is global per token, so a 1-wallet run cannot share the same token and window. 1 wallet against 100 is checked in the contract unit test and the engine test above.

## Simulation (60 days)

The simulator is in the repository and its numbers can be reproduced with `node sim/run.mjs`. It runs the rule engine (`web/engine.js`, the same file the page uses) against two baselines, `naive` (no rule) and `per_wallet` (0.5% of supply per transaction, 60 s cooldown per wallet), in four scenarios with nine seeds each. The engine implements the same balance, exit, bucket and pool rules as the contract and is tested against the spec; it does not model storage cost, asynchronous receipts or `ft_transfer_call` refunds. **How people behave is assumed.** Full tables and assumptions: [sim/RESULTS.md](sim/RESULTS.md).

Coordinated dump of the early supply (13.6% of supply in 30 wallets) on day 1, median of 9 seeds:

| rule | largest 1-hour price drop, after the first 12 h | time until 99.9% of early supply is sold | early-supply sales announced in advance | modelled holder exit price 1 min after the first sign |
|---|---|---|---|---|
| naive | 44.6% | at once | 0% | 61.9% |
| per_wallet | 44.6% | at once | 0% | 61.9% |
| LOUD standard | 19.5% | 27.1 h | 100% | 100.0% |

How to read the columns. The 1-hour drop leaves out the first 12 hours, when a thin pool swings widely under every rule. Exit time runs from the first sell attempt until 99.9% of early supply is sold. "Announced in advance" counts early-supply sales only, and those are about 9% of all units sold in the LOUD standard run; the other sales are ordinary quiet sales with no notice. The holder exit price is a modelled quote for selling 0.01% of supply, relative to the price just before the first sign; it is computed from the pool state and is not an observed trade. If the pool could not pay for the whole lot it is the price of the payable part only.

Where LOUD does worse in this model: in a calm launch and in a slow bleed, the standard preset shows a larger 1-hour drop than the baselines (14.0% against 11.0% and 10.7%), because holders are assumed to rush out when they see a shout. With that rush set to zero the day-1 drop is 8.8%; at three times the assumed rush it is 39.2%. A loose setting (2% per hour, 10 min notice) is about as bad as no rule.

**Replay on real data: none.** `sim/replay.mjs` can replay a real bundled launch from minute candles, but no suitable verified data set was assembled: minute candles were reachable without a key for recent pools, but none could be tied to a documented bundled launch. [sim/REPLAY.md](sim/REPLAY.md) contains no numbers.

## Limits

- **Wrappers and side deals.** Loud tokens can be sent to a custom contract with plain `ft_transfer`, and claims on them, or the account itself, can be sold off-pool. The tag still follows the tokens, so whoever ends up with them faces the same door. LOUD limits the pool exit, not side deals.
- **Other pools.** Loud tokens cannot enter other contracts through `ft_transfer_call`. Quiet tokens are exempt from the notice and the cap and can use `ft_transfer_call`. That is an exemption, not a promise of a market: the built-in pool can still refuse a sale it cannot pay, and other venues decide for themselves what they accept.
- **First come, first served.** Ready exits share the bucket in the order their `leave` calls land. A large holder can take a whole window's room.
- **Early honest buyers are loud too.** Anyone who buys in the launch window accepts the door.
- **A notice can trigger a rush.** Quiet holders can sell before a shouted exit becomes ready. That is the intended information, and it can also speed up a sell-off.
- **The creator allocation is unbacked.** It is minted without a NEAR payment, so every NEAR it receives through the door comes from buyers. After the creator has left, the pool can hold less NEAR than the formula price of the remaining tokens. `sell` fails with `E_POOL_EMPTY` when the pool cannot pay the formula amount, and `leave` fills only the part the pool can pay. So the last sellers may be unable to sell part or all of their tokens.
- **Storage.** The contract pays account storage out of the same balance that holds the pool's NEAR. Dust transfers to many fresh accounts grow that storage, and when the spare balance is used up, `sell` and `leave` calls that pay NEAR can fail until someone sends NEAR to the token account; a failed call changes nothing, so the seller keeps the tokens. Separately, a payout whose NEAR transfer fails after the call itself succeeded (for example because the receiving account no longer exists) is no longer lost in the contract source: the `on_payout` callback records the amount for that account, which can call `claim()` with 1 yoctoNEAR attached. Nothing retries automatically, and the record is lost if the callback itself fails. The failure path is covered by unit tests only; the testnet run had no failed payout. Acceptable on testnet, not on mainnet.
- **Sybil resistance.** The cap is global, so more accounts never mean more exit room. That is the whole defence; there is no per-person fairness and no identity.
- No fee, no liquidity migration, no audit, no mainnet token.

## Layout

| Path | What |
|---|---|
| `contracts/loud-math` | Pool and bucket integer math, no dependency. |
| `contracts/loud` | The token: NEP-141 with the two-balance rule, the built-in pool and the exits. |
| `web/engine.js` | The same balance, exit, bucket and pool rules in JavaScript, used by the page and the simulator. Not modelled: storage cost, asynchronous receipts, `ft_transfer_call` refunds. |
| `web/` | The static page. |
| `sim/` | 60-day simulation and the replay loader. |
| `scripts/proof` | The testnet run. |

## Libraries and AI use

- Contract: [near-sdk](https://github.com/near/near-sdk-rs) 5.30.1 (the only external direct crate dependency; the other direct dependency is the in-repo `loud-math` crate), built with cargo-near 0.23.0 on Rust 1.95.0.
- Proof run: [near-api-js](https://github.com/near/near-api-js) 5.1.1 for keys and transaction signing, used only inside the CI job.
- Page, engine, simulator and RPC client: no dependency.
- The code, tests and text in this repository were written with AI coding agents (Claude Code) directed and reviewed by the author. Findings from independent AI review passes were fixed or are listed under Limits.

## License

MIT, see [LICENSE](LICENSE).
