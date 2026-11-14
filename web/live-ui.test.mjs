import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as TL from './live-ui.js';

const NEAR = 10n ** 24n;
const UNIT = 10n ** 18n;
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('wallet store: reads what it wrote and ignores anything else', () => {
  const store = {
    wallets: [
      { accountId: 'loud-try-a1.testnet', publicKey: 'ed25519:AAA', secretKey: 'ed25519:SSS', extra: 1 },
      { accountId: 'loud-try-b2.testnet', publicKey: 'ed25519:BBB', secretKey: 'ed25519:TTT' },
    ],
    active: 1,
  };
  const back = TL.parseWallets(TL.serializeWallets(store));
  assert.equal(back.active, 1);
  assert.deepEqual(back.wallets.map((w) => w.accountId), ['loud-try-a1.testnet', 'loud-try-b2.testnet']);
  assert.equal(back.wallets[0].extra, undefined);
  for (const bad of [null, '', 'not json', '{}', '{"wallets":7}', '{"wallets":[{"accountId":"UPPER","publicKey":"a","secretKey":"b"}]}']) {
    assert.deepEqual(TL.parseWallets(bad), { wallets: [], active: 0 });
  }
  // At most two wallets, and an active index outside them falls back to the first.
  const three = { wallets: [store.wallets[0], store.wallets[1], store.wallets[0]], active: 5 };
  const cut = TL.parseWallets(JSON.stringify(three));
  assert.equal(cut.wallets.length, 2);
  assert.equal(cut.active, 0);
});

test('live.json: a token account is required', () => {
  assert.equal(TL.liveConfig(null), null);
  assert.equal(TL.liveConfig({}), null);
  assert.equal(TL.liveConfig({ token_account: 'Not An Account' }), null);
  const cfg = TL.liveConfig({ token_account: 't.loud-x1.testnet', zero_keys: true, loud_until: '2026-11-21T10:00:00.000Z', preset: 'live' });
  assert.equal(cfg.token, 't.loud-x1.testnet');
  assert.equal(cfg.tokenHref, 'https://testnet.nearblocks.io/address/t.loud-x1.testnet');
  assert.equal(cfg.zeroKeys, true);
  assert.equal(cfg.loudUntilMs, Date.parse('2026-11-21T10:00:00.000Z'));
  assert.equal(TL.liveConfig({ token_account: 't.loud-x1.testnet' }).zeroKeys, false);
});

test('buy plan: storage on the first buy, floor and gas reserve', () => {
  const fresh = { registered: false, near: 10n * NEAR };
  const plan = TL.buyPlan('2', fresh);
  assert.equal(plan.deposit, 2n * NEAR);
  assert.equal(plan.storage, TL.STORAGE_FEE);
  assert.equal(plan.intoPool, 2n * NEAR - TL.STORAGE_FEE);
  assert.match(TL.buyPlan('0.03', fresh).error, /0\.031 NEAR/);
  const known = { registered: true, near: 10n * NEAR };
  assert.equal(TL.buyPlan('0.5', known).storage, 0n);
  assert.match(TL.buyPlan('0.0001', known).error, /at least 0\.001 NEAR/);
  assert.match(TL.buyPlan('10', known).error, /leave about 0\.05 NEAR for gas/);
  assert.throws(() => TL.buyPlan('abc', known), /positive number/);
  // min_tokens_out leaves 2% slack under the quote.
  assert.deepEqual(TL.buyArgs(plan, '1000000'), { min_tokens_out: '980000' });
});

test('catch: a quarter, or everything when a quarter would leave dust', () => {
  const supply = 1_000_000_000n * UNIT; // dust floor 1,000 LOUD
  assert.equal(TL.quarterOf(40_000_000n * UNIT, supply), 10_000_000n * UNIT);
  // Whole tokens only.
  assert.equal(TL.quarterOf(10n * UNIT + 3n, supply), 10n * UNIT + 3n);
  assert.equal(TL.quarterOf(1_200n * UNIT, supply), 1_200n * UNIT); // 900 would be left: below the floor
  assert.equal(TL.quarterOf(2n, supply), 2n);
  const plan = TL.catchPlan({ near_in: (NEAR).toString(), fee: (NEAR / 100n).toString() }, { near: 5n * NEAR });
  assert.equal(plan.price, NEAR);
  assert.equal(plan.fee, NEAR / 100n);
  assert.equal(plan.deposit, NEAR + NEAR / 50n + 1n);
  assert.match(TL.catchPlan({ near_in: (6n * NEAR).toString(), fee: '0' }, { near: 5n * NEAR }).error, /Catch a quarter, or get the second wallet/);
});

test('board rows: who may press what', () => {
  const SEC = 1_000_000_000n;
  const t0 = 1_800_000_000n * SEC;
  const ex = (id, owner, shouted, remaining = 100n) => ({
    id: String(id), owner, amount: (200n * UNIT).toString(), remaining: (remaining * UNIT).toString(),
    shouted_at: shouted.toString(), ready_at: (shouted + 60n * SEC).toString(), expires_at: (shouted + 1860n * SEC).toString(),
  });
  const exits = [ex(1, 'me.testnet', t0), ex(2, 'other.testnet', t0), ex(3, 'other.testnet', t0 - 4000n * SEC), ex(4, 'mine-b.testnet', t0)];
  const during = TL.liveRows(exits, t0 + 10n * SEC, 'me.testnet', ['me.testnet', 'mine-b.testnet']);
  const row = (rows, id) => rows.find((r) => r.id === String(id));
  // My exit in its notice: no leave yet; hush is shown so the refusal can be seen.
  assert.deepEqual([row(during, 1).status, row(during, 1).canLeave, row(during, 1).canHush, row(during, 1).canCatch], ['NOTICE', false, true, false]);
  assert.match(row(during, 1).detail, /^this wallet, 100 sold or caught, ready in 50 s$/);
  // Someone else's open exit: catch only.
  assert.deepEqual([row(during, 2).canLeave, row(during, 2).canHush, row(during, 2).canCatch], [false, false, true]);
  // Someone else's expired exit: anyone may hush it, nobody can catch it.
  assert.deepEqual([row(during, 3).status, row(during, 3).canHush, row(during, 3).canCatch], ['EXPIRED', true, false]);
  assert.match(row(during, 4).detail, /^your other wallet/);
  const after = TL.liveRows(exits, t0 + 61n * SEC, 'me.testnet');
  assert.deepEqual([row(after, 1).status, row(after, 1).canLeave], ['BOARDING', true]);
  // Without a wallet nothing can be pressed except hush on expired exits.
  const anon = TL.liveRows(exits, t0 + 61n * SEC, '');
  assert.deepEqual(anon.map((r) => [r.canLeave, r.canCatch, r.canHush]), [[false, false, false], [false, false, false], [false, false, true], [false, false, false]]);
  assert.equal(row(anon, 1).amount, '100');
});

test('results: plain words, the contract code and its hint', () => {
  const ctx = { accountId: 'a.testnet', call: 'sell 5 LOUD', amount: 5n * UNIT };
  const no = TL.describeResult('sell', ctx, { ok: false, hash: 'H', errorCode: 'E_NO_QUIET', errorMessage: 'E_NO_QUIET: sell uses quiet tokens only', explorerUrl: 'https://testnet.nearblocks.io/txns/H' });
  assert.equal(no.ok, false);
  assert.equal(no.call, 'a.testnet  sell 5 LOUD  rejected');
  assert.equal(no.message, 'E_NO_QUIET: sell uses quiet tokens only');
  assert.equal(no.hint, TL.LIVE_HINTS.E_NO_QUIET);
  assert.equal(no.explorerUrl, 'https://testnet.nearblocks.io/txns/H');
  const lost = TL.describeResult('sell', ctx, { ok: false });
  assert.match(lost.hint, /Nothing was recorded on chain/);
  const part = TL.describeResult('leave', { accountId: 'a.testnet', call: 'leave exit 3', remaining: 20n * UNIT }, { ok: true, value: (5n * UNIT).toString() });
  assert.match(part.message, /^Partial fill: 5 LOUD sold into the pool\. The shared cap had no more room; 15 LOUD stay in the exit\.$/);
  const all = TL.describeResult('leave', { accountId: 'a.testnet', call: 'leave exit 3', remaining: 5n * UNIT }, { ok: true, value: (5n * UNIT).toString() });
  assert.match(all.message, /The exit is closed\.$/);
  const caught = TL.describeResult('catch', { accountId: 'b.testnet', call: 'catch', amount: 4n * UNIT, exitId: '3', price: NEAR, fee: NEAR / 100n }, { ok: true, settled: false });
  assert.match(caught.message, /Caught 4 LOUD from exit 3 for about 1\.0000 NEAR\. 0\.010000 NEAR of it, the 1% fee, stays in the pool/);
  assert.match(caught.message, /has not settled yet/);
  const shout = TL.describeResult('shout', { accountId: 'a.testnet', call: 'shout', amount: 9n * UNIT, noticeSec: 60 }, { ok: true, value: '7' });
  assert.match(shout.message, /^Exit 7 is on the board: 9 LOUD locked\. Leave opens after the 1 min notice\./);
  for (const code of ['E_NO_QUIET', 'E_NOTICE', 'E_NOTICE_BINDING', 'E_CAP', 'E_SELF', 'E_DEPOSIT', 'E_DUST', 'E_EXPIRED']) {
    assert.ok(TL.LIVE_HINTS[code].length > 20, code);
  }
});

test('mock chain: the whole path a visitor takes, through the same functions as chain.js', async () => {
  let ms = 0;
  const chain = TL.createMockChain({ nowMs: () => ms });
  const T = TL.MOCK_TOKEN;
  const a = await chain.createTestWallet({ prefix: 'loud-try' });
  const b = await chain.createTestWallet({ prefix: 'loud-try' });
  assert.notEqual(a.accountId, b.accountId);
  let live = await TL.readLive(chain, T, [a.accountId, b.accountId]);
  assert.equal(live.accounts[0].near, 10n * NEAR);
  assert.equal(live.accounts[0].registered, false);
  assert.equal(live.state.is_loud_window, true);
  const header = TL.liveHeader(live, TL.liveConfig(TL.mockLiveJson()));
  assert.deepEqual(header.map((r) => r[0]), ['Token account', 'Access keys', 'Launch window', 'Notice', 'Exit window', 'Cap', 'Open exits', 'In the pool']);
  assert.match(header[2][1], /^open until .* UTC\. Every buy until then is loud\.$/);
  assert.equal(header[3][1], '1 min');
  assert.match(header[5][1], /^5,000,000 LOUD \(0\.5% of supply\) per 10 min/);

  // Buy: loud, and the first buy registers the wallet.
  const plan = TL.buyPlan('2', live.accounts[0]);
  const quote = await chain.view(T, 'quote_buy', { near: plan.intoPool.toString() });
  const buy = await chain.call(a, T, 'buy', TL.buyArgs(plan, quote), { gasTgas: TL.GAS_DEFAULT, depositYocto: plan.deposit.toString() });
  assert.equal(buy.ok, true);
  assert.match(buy.explorerUrl, /^https:\/\/testnet\.nearblocks\.io\/txns\/[1-9A-HJ-NP-Za-km-z]{44}$/);
  live = await TL.readLive(chain, T, [a.accountId, b.accountId]);
  const loud = live.accounts[0].loud;
  assert.ok(loud > 5_000_000n * UNIT, 'a 2 NEAR buy is more than one cap');
  assert.equal(live.accounts[0].quiet, 0n);
  assert.equal(live.accounts[0].registered, true);

  // Sell is refused for loud tokens.
  const sell = await chain.call(a, T, 'sell', { amount: loud.toString(), min_near_out: '0' }, { depositYocto: '1' });
  assert.equal(sell.ok, false);
  assert.equal(sell.errorCode, 'E_NO_QUIET');

  // Shout, then the owner can neither leave nor hush during the notice.
  const shout = await chain.call(a, T, 'shout', { amount: loud.toString() }, { depositYocto: '1' });
  assert.equal(shout.ok, true);
  const id = shout.value;
  assert.equal((await chain.call(a, T, 'leave', { exit_id: id, min_near_out: '0' }, { depositYocto: '1' })).errorCode, 'E_NOTICE');
  assert.equal((await chain.call(a, T, 'hush', { exit_id: id }, { depositYocto: '1' })).errorCode, 'E_NOTICE_BINDING');
  assert.equal((await chain.call(a, T, 'catch', { exit_id: id }, { depositYocto: (5n * NEAR).toString() })).errorCode, 'E_SELF');

  // The second wallet is not registered: its catch is refused until it pays storage.
  live = await TL.readLive(chain, T, [a.accountId, b.accountId]);
  const rowsB = TL.liveRows(live.exits, TL.chainNow(live, live.readAtMs), b.accountId, [a.accountId, b.accountId]);
  assert.deepEqual([rowsB[0].canCatch, rowsB[0].canLeave, rowsB[0].canHush], [true, false, false]);
  const amount = TL.quarterOf(live.exits[0].remaining, live.params.total_supply);
  const q = await chain.view(T, 'quote_catch', { exit_id: id, amount: amount.toString() });
  const cp = TL.catchPlan(q, live.accounts[1]);
  const early = await chain.call(b, T, 'catch', { exit_id: id, amount: amount.toString() }, { gasTgas: TL.GAS_CATCH, depositYocto: cp.deposit.toString() });
  assert.equal(early.errorCode, 'E_UNREGISTERED');
  assert.equal((await chain.call(b, T, 'storage_deposit', {}, { depositYocto: TL.STORAGE_FEE.toString() })).ok, true);
  const nearA = BigInt((await chain.accountState(a.accountId)).amountYocto);
  const caught = await chain.call(b, T, 'catch', { exit_id: id, amount: amount.toString() }, { gasTgas: TL.GAS_CATCH, depositYocto: cp.deposit.toString() });
  assert.equal(caught.ok, true);
  live = await TL.readLive(chain, T, [a.accountId, b.accountId]);
  assert.equal(live.accounts[1].loud, amount);
  assert.equal(live.accounts[1].quiet, 0n);
  assert.equal(live.exits[0].remaining, loud - amount);
  // The seller got the price less the 1% fee; the pool sold nothing.
  assert.equal(BigInt((await chain.accountState(a.accountId)).amountYocto) - nearA, cp.price - cp.fee);
  assert.equal(live.state.total_left, 0n);

  // After the notice the owner leaves: the shared cap fills only part.
  ms += 61_000;
  live = await TL.readLive(chain, T, [a.accountId]);
  const rowsA = TL.liveRows(live.exits, TL.chainNow(live, live.readAtMs), a.accountId);
  assert.deepEqual([rowsA[0].status, rowsA[0].canLeave], ['BOARDING', true]);
  const leave = await chain.call(a, T, 'leave', { exit_id: id, min_near_out: '0' }, { depositYocto: '1' });
  assert.equal(leave.ok, true);
  const told = TL.describeResult('leave', { accountId: a.accountId, call: `leave exit ${id}`, remaining: live.exits[0].remaining }, leave);
  assert.match(told.message, /^Partial fill: /);
  assert.ok(BigInt(leave.value) < 5_000_000n * UNIT);
  // The cap bar grows between reads.
  const cap0 = TL.capView(live, live.state.now);
  const cap1 = TL.capView(live, live.state.now + 300n * 1_000_000_000n);
  assert.ok(cap1.fraction > cap0.fraction);
  assert.match(cap1.text, / of 5,000,000 LOUD may leave now$/);

  // A wallet without NEAR for the deposit never reaches the chain.
  const poor = await chain.call(b, T, 'buy', { min_tokens_out: '0' }, { depositYocto: (50n * NEAR).toString() });
  assert.deepEqual([poor.ok, poor.hash], [false, null]);
  const failing = TL.createMockChain({ faucetFails: true });
  await assert.rejects(failing.createTestWallet({}), /429/);
  assert.match(TL.faucetFailure(new Error('faucet answered HTTP 429')), /did not create a wallet: faucet answered HTTP 429\. Try again in a minute\.$/);
});

test('page: the live section is wired to ids the script uses, and says what it is', () => {
  const html = read('./index.html');
  const app = read('./app.js');
  const at = html.indexOf('<section class="row" id="try"');
  assert.ok(at > html.indexOf('id="board"') && at < html.indexOf('<section class="summary"'));
  const body = html.slice(at, html.indexOf('</section>', at));
  for (const m of app.matchAll(/\$\('#(try-[\w-]+)'/g)) assert.ok(body.includes(`id="${m[1]}"`), `missing #${m[1]}`);
  assert.match(body, /<h2 id="try-h">Use it on testnet<\/h2>/);
  assert.match(body, /Testnet only, throwaway, no real funds\./);
  assert.match(body, /never sent anywhere/);
  assert.match(body, /its launch window stays open for seven days, so every buy is loud/);
  assert.match(body, /Nobody holds quiet tokens on it yet\./);
  // Controls are hidden until the token has been read.
  assert.match(body, /<div id="try-app" hidden>/);
  // The simulator no longer reads as the product.
  assert.match(html, /<h2 id="sandbox-h">Simulator: play the rule by hand, no chain<\/h2>/);
  assert.match(html, /<a href="#try">Use it on testnet<\/a>/);
  // Chain data never goes through innerHTML.
  assert.ok(!/innerHTML/.test(app));
});
