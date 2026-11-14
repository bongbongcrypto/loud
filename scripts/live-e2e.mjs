// The visitor's path of the page, on chain, signed by web/chain.js (the code the page
// runs; no near-api-js here). Runs in GitHub Actions only: the two keys it makes live in
// the job's memory and are never written anywhere.
//
// Against the token named in web/live.json:
//   two test wallets from the faucet; A buys in the launch window and holds loud tokens;
//   A's sell is refused; A shouts; A's early leave and its hush are refused; B registers
//   and catches a quarter of the exit; A cannot catch its own exit; after the notice A
//   leaves and the shared cap fills part of it.
// Prints one JSON line per step and exits 1 on the first mismatch.
//
//   node scripts/live-e2e.mjs

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as C from '../web/chain.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const live = JSON.parse(await readFile(path.join(HERE, '..', 'web', 'live.json'), 'utf8'));
const TOKEN = process.env.LIVE_TOKEN || live.token_account;
// Gas per call, as the proof run attaches it (scripts/proof/proof.mjs).
const GAS = { buy: 50, sell: 80, shout: 30, leave: 80, hush: 30, catch: 120, storage_deposit: 30 };
const NEAR = 10n ** 24n;
const STORAGE_MIN = 3n * 10n ** 22n;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const started = Date.now();

const steps = [];
function record(step, ok, detail) {
  const line = { step, ok, t: Math.round((Date.now() - started) / 1000), ...detail };
  steps.push(line);
  console.log(JSON.stringify(line));
  if (!ok) {
    console.error(`live e2e stopped at "${step}"`);
    process.exit(1);
  }
}
const brief = (r) => ({ hash: r.hash, outcome: r.outcome, errorCode: r.errorCode, value: r.value, settled: r.settled, error: r.errorMessage ? r.errorMessage.slice(0, 160) : null });

// Views can lag a block behind a final transaction, so read until the condition holds.
async function readUntil(read, ok, tries = 12) {
  let v;
  for (let i = 0; i < tries; i++) {
    v = await read();
    if (ok(v)) return v;
    await sleep(1500);
  }
  return v;
}
const account = (id) => C.view(TOKEN, 'get_account', { account_id: id });

if (live.status !== 'ok' || !TOKEN) {
  console.error('web/live.json names no deployed token');
  process.exit(1);
}
const params = await C.view(TOKEN, 'get_params');
const state0 = await C.view(TOKEN, 'get_state');
record('token', state0.is_loud_window === true, {
  token: TOKEN, is_loud_window: state0.is_loud_window, cap_units: params.cap_units, notice_ns: params.notice_ns,
  pool_near: state0.pool_near, open_exits: state0.open_exits,
});

// Two test wallets
const t0 = Date.now();
const a = await C.createTestWallet({ prefix: 'loud-e2e-a' });
const tA = Date.now() - t0;
const b = await C.createTestWallet({ prefix: 'loud-e2e-b' });
const tB = Date.now() - t0 - tA;
const balA = await C.accountState(a.accountId);
const balB = await C.accountState(b.accountId);
record('two test wallets from the faucet', balA.exists && balB.exists && BigInt(balA.amountYocto) > 3n * NEAR, {
  a: a.accountId, b: b.accountId, grant_a_yocto: balA.amountYocto, grant_b_yocto: balB.amountYocto, ms_a: tA, ms_b: tB,
});

// A buys with 2 NEAR: the first buy pays the 0.03 NEAR registration out of the deposit.
const buy = await C.call(a, TOKEN, 'buy', { min_tokens_out: '1' }, { gasTgas: GAS.buy, depositYocto: (2n * NEAR).toString() });
const afterBuy = await readUntil(() => account(a.accountId), (v) => BigInt(v.loud) > 0n);
record('A buys with 2 NEAR and holds loud tokens', buy.ok && BigInt(afterBuy.loud) > 0n && BigInt(afterBuy.quiet) === 0n && String(buy.value) === afterBuy.loud, {
  ...brief(buy), loud: afterBuy.loud, quiet: afterBuy.quiet,
});
const loud = BigInt(afterBuy.loud);

// A's sell is refused: loud tokens cannot use sell.
const sell = await C.call(a, TOKEN, 'sell', { amount: loud.toString(), min_near_out: '0' }, { gasTgas: GAS.sell, depositYocto: '1' });
record('A calls sell with loud tokens: refused', sell.outcome === 'failure' && sell.errorCode === 'E_NO_QUIET', brief(sell));

// A shouts everything.
const shout = await C.call(a, TOKEN, 'shout', { amount: loud.toString() }, { gasTgas: GAS.shout, depositYocto: '1' });
const afterShout = await readUntil(() => account(a.accountId), (v) => v.exits.length === 1);
const exit = afterShout.exits[0];
record('A shouts its whole balance', shout.ok && Boolean(exit) && String(exit.id) === String(shout.value) && exit.remaining === loud.toString() && afterShout.loud === '0', {
  ...brief(shout), exit,
});
const exitId = String(exit.id);

// Early leave and hush: both refused.
const early = await C.call(a, TOKEN, 'leave', { exit_id: exitId, min_near_out: '0' }, { gasTgas: GAS.leave, depositYocto: '1' });
record('A calls leave before the notice ends: refused', early.outcome === 'failure' && early.errorCode === 'E_NOTICE', brief(early));
const hush = await C.call(a, TOKEN, 'hush', { exit_id: exitId }, { gasTgas: GAS.hush, depositYocto: '1' });
record('A tries to take the shout back with hush: refused', hush.outcome === 'failure' && hush.errorCode === 'E_NOTICE_BINDING', brief(hush));

// B registers and catches a quarter of the exit.
const reg = await C.call(b, TOKEN, 'storage_deposit', {}, { gasTgas: GAS.storage_deposit, depositYocto: STORAGE_MIN.toString() });
const registered = await readUntil(() => C.view(TOKEN, 'is_registered', { account_id: b.accountId }), (v) => v === true);
record('B registers with storage_deposit', reg.ok && registered === true, brief(reg));

const catchAmount = loud / 4n;
const quote = await C.view(TOKEN, 'quote_catch', { exit_id: exitId, amount: catchAmount.toString() });
const deposit = (BigInt(quote.near_in) * 102n + 99n) / 100n; // quote plus 2%, rounded up
const stateBefore = await C.view(TOKEN, 'get_state');
const self = await C.call(a, TOKEN, 'catch', { exit_id: exitId, amount: catchAmount.toString() }, { gasTgas: GAS.catch, depositYocto: deposit.toString() });
record('A tries to catch its own exit: refused', self.outcome === 'failure' && self.errorCode === 'E_SELF', brief(self));

const caught = await C.call(b, TOKEN, 'catch', { exit_id: exitId, amount: catchAmount.toString() }, { gasTgas: GAS.catch, depositYocto: deposit.toString() });
const bAfter = await readUntil(() => account(b.accountId), (v) => BigInt(v.loud) > 0n);
const aAfterCatch = await readUntil(() => account(a.accountId), (v) => v.exits[0] && v.exits[0].remaining !== loud.toString());
const stateAfter = await C.view(TOKEN, 'get_state');
const catchEvent = caught.events.find((e) => e.standard === 'loud' && e.event === 'catch');
record('B catches a quarter of the exit: the tokens arrive loud, the pool sells nothing', caught.ok && caught.settled
  && String(caught.value) === catchAmount.toString()
  && bAfter.loud === catchAmount.toString() && bAfter.quiet === '0'
  && aAfterCatch.exits[0]?.remaining === (loud - catchAmount).toString()
  && stateAfter.pool_tokens === stateBefore.pool_tokens
  && Boolean(catchEvent), {
  ...brief(caught), amount: catchAmount.toString(), quote_near_in: quote.near_in, quote_fee: quote.fee, attached: deposit.toString(),
  event: catchEvent?.data ?? null, b_loud: bAfter.loud, exit_remaining: aAfterCatch.exits[0]?.remaining ?? null,
  pool_tokens_before: stateBefore.pool_tokens, pool_tokens_after: stateAfter.pool_tokens,
  pool_near_before: stateBefore.pool_near, pool_near_after: stateAfter.pool_near,
});

// Wait out the notice on chain time, then A leaves.
const readyAt = BigInt(exit.ready_at);
for (;;) {
  const now = BigInt((await C.view(TOKEN, 'get_state')).now);
  if (now >= readyAt + 2_000_000_000n) break;
  await sleep(Math.min(Math.max(Number((readyAt - now) / 1_000_000n) + 2000, 2000), 15_000));
}
const remaining = loud - catchAmount;
const capBefore = BigInt((await C.view(TOKEN, 'get_state')).cap_available);
const leave = await C.call(a, TOKEN, 'leave', { exit_id: exitId, min_near_out: '0' }, { gasTgas: GAS.leave, depositYocto: '1' });
const filled = leave.value === null ? 0n : BigInt(leave.value);
const aEnd = await readUntil(() => account(a.accountId), (v) => !v.exits[0] || v.exits[0].remaining !== remaining.toString());
record('after the notice A leaves: the shared cap fills part of the exit', leave.ok && leave.settled
  && filled > 0n && filled <= BigInt(params.cap_units) && filled < remaining
  && aEnd.exits[0]?.remaining === (remaining - filled).toString(), {
  ...brief(leave), filled: filled.toString(), cap_units: params.cap_units, cap_available_before: capBefore.toString(),
  exit_remaining: aEnd.exits[0]?.remaining ?? null,
});

console.log(JSON.stringify({ result: 'ok', token: TOKEN, steps: steps.length, seconds: Math.round((Date.now() - started) / 1000) }));
