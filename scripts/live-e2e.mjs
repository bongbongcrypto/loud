// The visitor's path of the page, on chain, signed by web/chain.js (the code the page
// runs; no near-api-js here). Runs in GitHub Actions only: the keys it makes live in the
// job's memory and are never written anywhere.
//
// Against the token named in web/live.json:
//   wallet A from the faucet (the one faucet request); wallet B made from A with 3 NEAR in
//   one transaction, as the page does; A buys in the launch window and holds loud tokens;
//   A's sell is refused; A shouts; A's early leave and its hush are refused; B registers
//   and catches a quarter of the exit; A cannot catch its own exit; after the notice A
//   leaves and the exit is filled in part.
// Prints one JSON line per step, writes every step to web/live-e2e.json (account ids,
// calls, hashes, outcomes, error codes and the numbers from the receipt events; never a
// key) and exits 1 on the first mismatch, after writing the file.
//
//   node scripts/live-e2e.mjs

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as C from '../web/chain.js';
import { partialReason } from '../web/live-ui.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'web', 'live-e2e.json');
const live = JSON.parse(await readFile(path.join(HERE, '..', 'web', 'live.json'), 'utf8'));
const TOKEN = process.env.LIVE_TOKEN || live.token_account;
// Gas per call, as the proof run attaches it (scripts/proof/proof.mjs).
const GAS = { buy: 50, sell: 80, shout: 30, leave: 80, hush: 30, catch: 120, storage_deposit: 30 };
const NEAR = 10n ** 24n;
const STORAGE_MIN = 3n * 10n ** 22n;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const started = Date.now();

const record = {
  status: 'running',
  network: C.NETWORK,
  token: TOKEN,
  started_at: new Date(started).toISOString(),
  finished_at: null,
  seconds: null,
  commit: process.env.GITHUB_SHA || null,
  run: process.env.GITHUB_RUN_ID ? { repository: process.env.GITHUB_REPOSITORY || null, run_id: process.env.GITHUB_RUN_ID } : null,
  faucet: [],
  wallets: {},
  steps: [],
};

async function finish(status, error = null) {
  record.status = status;
  record.finished_at = new Date().toISOString();
  record.seconds = Math.round((Date.now() - started) / 1000);
  if (error) record.error = String(error).slice(0, 400);
  await writeFile(OUT, `${JSON.stringify(record, null, 2)}\n`);
}

async function step(name, ok, detail) {
  const line = { step: name, ok, at: new Date().toISOString(), t: Math.round((Date.now() - started) / 1000), ...detail };
  record.steps.push(line);
  console.log(JSON.stringify(line));
  if (!ok) {
    console.error(`live e2e stopped at "${name}"`);
    await finish('failed', `stopped at "${name}"`);
    process.exit(1);
  }
}

// What one call returned, without anything secret.
const brief = (account, call, r) => ({
  account, call, hash: r.hash, outcome: r.outcome, error_code: r.errorCode, value: r.value, settlement: r.settlement ?? null,
  signed: r.signedHashes ? r.signedHashes.length : null, error: r.errorMessage ? r.errorMessage.slice(0, 160) : null,
});
const eventOf = (r, name) => (r.events || []).find((e) => e.standard === 'loud' && e.event === name)?.data ?? null;

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

async function main() {
  if (live.status !== 'ok' || !TOKEN) throw new Error('web/live.json names no deployed token');
  const params = await C.view(TOKEN, 'get_params');
  const state0 = await C.view(TOKEN, 'get_state');
  await step('token', state0.is_loud_window === true, {
    token: TOKEN, is_loud_window: state0.is_loud_window, cap_units: params.cap_units, notice_ns: params.notice_ns,
    pool_near: state0.pool_near, open_exits: state0.open_exits,
  });

  // Wallet A: the one request to the faucet.
  const t0 = Date.now();
  let a;
  try {
    a = await C.createTestWallet({ prefix: 'loud-e2e-a', onAnswer: (x) => record.faucet.push({ ...x, at: new Date().toISOString() }) });
  } catch (e) {
    await step('wallet A from the faucet', false, { faucet_status: e.status ?? null, faucet_answer: e.answer ?? null, error: e.message.slice(0, 300) });
  }
  const balA0 = await C.accountState(a.accountId);
  record.wallets.a = a.accountId;
  await step('wallet A from the faucet', balA0.exists && BigInt(balA0.amountYocto) > 5n * NEAR, {
    account: a.accountId, grant_yocto: balA0.amountYocto, ms: Date.now() - t0, faucet: record.faucet.at(-1) ?? null,
  });

  // Wallet B: made from A with 3 NEAR in one transaction (CreateAccount, Transfer, AddKey).
  const b = await C.createSubWallet(a, { amountYocto: (3n * NEAR).toString() });
  const balB = await readUntil(() => C.accountState(b.accountId), (v) => v.exists);
  record.wallets.b = b.accountId;
  await step('wallet B made from wallet A with 3 NEAR', b.outcome === 'success' && b.result.ok && balB.exists && BigInt(balB.amountYocto) >= 2n * NEAR, {
    ...brief(a.accountId, `create ${b.accountId} with 3 NEAR`, b.result), new_account: b.accountId, balance_yocto: balB.amountYocto,
  });

  // A buys with 2 NEAR: the first buy pays the 0.03 NEAR registration out of the deposit.
  const buy = await C.call(a, TOKEN, 'buy', { min_tokens_out: '1' }, { gasTgas: GAS.buy, depositYocto: (2n * NEAR).toString() });
  const buyEv = eventOf(buy, 'buy');
  const afterBuy = await readUntil(() => account(a.accountId), (v) => BigInt(v.loud) > 0n);
  await step('A buys with 2 NEAR and holds loud tokens', buy.ok && buyEv !== null && buyEv.loud === true
    && afterBuy.loud === buyEv.tokens_out && BigInt(afterBuy.quiet) === 0n, {
    ...brief(a.accountId, 'buy with 2 NEAR', buy), tokens_out: buyEv?.tokens_out ?? null, loud_event: buyEv?.loud ?? null,
    storage_paid: buyEv?.storage_paid ?? null, loud: afterBuy.loud, quiet: afterBuy.quiet,
  });
  const loud = BigInt(afterBuy.loud);

  // A's sell is refused: loud tokens cannot use sell.
  const sell = await C.call(a, TOKEN, 'sell', { amount: loud.toString(), min_near_out: '0' }, { gasTgas: GAS.sell, depositYocto: '1' });
  await step('A calls sell with loud tokens: refused', sell.outcome === 'failure' && sell.errorCode === 'E_NO_QUIET', brief(a.accountId, 'sell all', sell));

  // A shouts its whole loud balance, as the page fills it in after a buy.
  const shout = await C.call(a, TOKEN, 'shout', { amount: loud.toString() }, { gasTgas: GAS.shout, depositYocto: '1' });
  const afterShout = await readUntil(() => account(a.accountId), (v) => v.exits.length === 1);
  const exit = afterShout.exits[0];
  await step('A shouts its whole balance', shout.ok && Boolean(exit) && String(exit.id) === String(shout.value) && exit.remaining === loud.toString() && afterShout.loud === '0', {
    ...brief(a.accountId, 'shout all', shout), exit_id: exit ? String(exit.id) : null, amount: exit?.amount ?? null, ready_at: exit?.ready_at ?? null,
  });
  const exitId = String(exit.id);

  // Early leave and hush: both refused.
  const early = await C.call(a, TOKEN, 'leave', { exit_id: exitId, min_near_out: '0' }, { gasTgas: GAS.leave, depositYocto: '1' });
  await step('A calls leave before the notice ends: refused', early.outcome === 'failure' && early.errorCode === 'E_NOTICE', brief(a.accountId, `leave exit ${exitId}`, early));
  const hush = await C.call(a, TOKEN, 'hush', { exit_id: exitId }, { gasTgas: GAS.hush, depositYocto: '1' });
  await step('A tries to take the shout back with hush: refused', hush.outcome === 'failure' && hush.errorCode === 'E_NOTICE_BINDING', brief(a.accountId, `hush exit ${exitId}`, hush));

  // B registers and catches a quarter of the exit.
  const reg = await C.call(b, TOKEN, 'storage_deposit', {}, { gasTgas: GAS.storage_deposit, depositYocto: STORAGE_MIN.toString() });
  const registered = await readUntil(() => C.view(TOKEN, 'is_registered', { account_id: b.accountId }), (v) => v === true);
  await step('B registers with storage_deposit', reg.ok && registered === true, brief(b.accountId, 'storage_deposit 0.03 NEAR', reg));

  const catchAmount = loud / 4n;
  const quote = await C.view(TOKEN, 'quote_catch', { exit_id: exitId, amount: catchAmount.toString() });
  const deposit = (BigInt(quote.near_in) * 102n + 99n) / 100n; // quote plus 2%, rounded up
  const stateBefore = await C.view(TOKEN, 'get_state');
  const self = await C.call(a, TOKEN, 'catch', { exit_id: exitId, amount: catchAmount.toString() }, { gasTgas: GAS.catch, depositYocto: deposit.toString() });
  await step('A tries to catch its own exit: refused', self.outcome === 'failure' && self.errorCode === 'E_SELF', brief(a.accountId, `catch exit ${exitId}`, self));

  const caught = await C.call(b, TOKEN, 'catch', { exit_id: exitId, amount: catchAmount.toString() }, { gasTgas: GAS.catch, depositYocto: deposit.toString() });
  const catchEv = eventOf(caught, 'catch');
  const bAfter = await readUntil(() => account(b.accountId), (v) => BigInt(v.loud) > 0n);
  const aAfterCatch = await readUntil(() => account(a.accountId), (v) => v.exits[0] && v.exits[0].remaining !== loud.toString());
  const stateAfter = await C.view(TOKEN, 'get_state');
  await step('B catches a quarter of the exit: the tokens arrive loud, the pool sells nothing', caught.ok && caught.settled
    && catchEv !== null && catchEv.amount === catchAmount.toString()
    && bAfter.loud === catchAmount.toString() && bAfter.quiet === '0'
    && aAfterCatch.exits[0]?.remaining === catchEv.remaining
    && stateAfter.pool_tokens === stateBefore.pool_tokens, {
    ...brief(b.accountId, `catch ${catchAmount} units of exit ${exitId}`, caught), quote_near_in: quote.near_in, attached: deposit.toString(),
    amount: catchEv?.amount ?? null, remaining: catchEv?.remaining ?? null, near_paid: catchEv?.near_paid ?? null, fee: catchEv?.fee ?? null,
    b_loud: bAfter.loud, pool_tokens_before: stateBefore.pool_tokens, pool_tokens_after: stateAfter.pool_tokens,
  });

  // Wait out the notice on chain time, then A leaves.
  const readyAt = BigInt(exit.ready_at);
  for (;;) {
    const now = BigInt((await C.view(TOKEN, 'get_state')).now);
    if (now >= readyAt + 2_000_000_000n) break;
    await sleep(Math.min(Math.max(Number((readyAt - now) / 1_000_000n) + 2000, 2000), 15_000));
  }
  const remaining = loud - catchAmount;
  const before = await C.view(TOKEN, 'get_state');
  const leave = await C.call(a, TOKEN, 'leave', { exit_id: exitId, min_near_out: '0' }, { gasTgas: GAS.leave, depositYocto: '1' });
  const leaveEv = eventOf(leave, 'leave');
  // Why the fill was partial, as the page tells it: get_state once it includes this call.
  const after = await readUntil(() => C.view(TOKEN, 'get_state'), (v) => Number(v.leave_count) > Number(before.leave_count));
  let reason = null;
  if (leaveEv && leaveEv.remaining !== '0') {
    const rest = BigInt(leaveEv.remaining);
    const room = BigInt(after.cap_available);
    const quoteForRest = await C.view(TOKEN, 'quote_sell', { amount: (rest < room ? rest : room).toString() });
    reason = partialReason({ capAvailable: after.cap_available, capUnits: after.cap_units, poolNear: after.pool_near, quoteForRest });
  }
  const aEnd = await readUntil(() => account(a.accountId), (v) => !v.exits[0] || v.exits[0].remaining !== remaining.toString());
  const filled = leaveEv ? BigInt(leaveEv.filled) : 0n;
  await step('after the notice A leaves: part of the exit is filled', leave.ok && leave.settled && leaveEv !== null
    && filled > 0n && filled <= BigInt(params.cap_units) && filled < remaining
    && aEnd.exits[0]?.remaining === leaveEv.remaining, {
    ...brief(a.accountId, `leave exit ${exitId}`, leave), filled: leaveEv?.filled ?? null, remaining: leaveEv?.remaining ?? null,
    near_out: leaveEv?.near_out ?? null, partial_reason: reason, cap_units: params.cap_units,
    cap_available_before: before.cap_available, cap_available_after: after.cap_available, pool_near_after: after.pool_near,
  });
}

try {
  await main();
  await finish('ok');
  console.log(JSON.stringify({ result: 'ok', token: TOKEN, steps: record.steps.length, seconds: record.seconds }));
} catch (e) {
  console.error(e);
  await finish('failed', e && e.message ? e.message : e);
  process.exit(1);
}
