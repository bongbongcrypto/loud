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

const ev = (event, data) => ({ standard: 'loud', event, data });

test('results: plain words, the contract code and its hint', () => {
  const ctx = { accountId: 'a.testnet', call: 'sell 5 LOUD', amount: 5n * UNIT };
  const no = TL.describeResult('sell', ctx, { ok: false, outcome: 'failure', hash: 'H', errorCode: 'E_NO_QUIET', errorMessage: 'E_NO_QUIET: sell uses quiet tokens only', explorerUrl: 'https://testnet.nearblocks.io/txns/H' });
  assert.equal(no.ok, false);
  assert.equal(no.call, 'a.testnet  sell 5 LOUD  rejected');
  assert.equal(no.message, 'E_NO_QUIET: sell uses quiet tokens only');
  assert.equal(no.hint, TL.LIVE_HINTS.E_NO_QUIET);
  assert.equal(no.explorerUrl, 'https://testnet.nearblocks.io/txns/H');
  const refused = TL.describeResult('sell', ctx, { ok: false, outcome: 'invalid', hash: null });
  assert.match(refused.hint, /refused this transaction before it ran, so nothing changed on chain/);
  assert.equal(refused.explorerUrl, null);
  const ranAndFailed = TL.describeResult('sell', ctx, { ok: false, outcome: 'failure', hash: 'H', explorerUrl: 'x' });
  assert.match(ranAndFailed.hint, /ran and failed/);
  const shout = TL.describeResult('shout', { accountId: 'a.testnet', call: 'shout', amount: 9n * UNIT, noticeSec: 60 }, { ok: true, value: '7' });
  assert.match(shout.message, /^Exit 7 is on the board: 9 LOUD locked\. Leave opens after the 1 min notice\./);
  for (const code of ['E_NO_QUIET', 'E_NOTICE', 'E_NOTICE_BINDING', 'E_CAP', 'E_SELF', 'E_DEPOSIT', 'E_DUST', 'E_EXPIRED', 'E_NOTHING_OWED']) {
    assert.ok(TL.LIVE_HINTS[code].length > 20, code);
  }
  // The shout minimum names the whole-balance exception the contract makes.
  assert.match(TL.LIVE_HINTS.E_DUST, /unless it is the wallet's whole loud balance and the wallet has no other open exit/);
  assert.doesNotMatch(TL.LIVE_HINTS.E_NO_EXIT, /up to date/);
});

test('results: a sent transaction without a final outcome is never "nothing was sent"', () => {
  const r = TL.describeResult('leave', { accountId: 'a.testnet', call: 'leave exit 3' }, {
    ok: false, outcome: 'unknown', hash: 'HASHX', explorerUrl: 'https://testnet.nearblocks.io/txns/HASHX', errorMessage: 'The transaction was sent, but no node returned its final outcome within 90 s',
  });
  assert.equal(r.ok, false);
  assert.equal(r.unknown, true);
  assert.equal(r.call, 'a.testnet  leave exit 3  sent, not confirmed');
  assert.equal(r.message, 'The transaction was sent, but NEAR testnet did not confirm it in time. It may still execute.');
  assert.match(r.hint, /explorer before you press the button again/);
  assert.equal(r.explorerUrl, 'https://testnet.nearblocks.io/txns/HASHX');
  assert.doesNotMatch(`${r.message} ${r.hint}`, /Nothing was/);
});

test('results: success lines take their numbers from the receipt events', () => {
  // buy: tokens_out and loud from the event, never from the pre-send window flag.
  const buy = TL.describeResult('buy', { accountId: 'a.testnet', call: 'buy with 2 NEAR', deposit: 2n * NEAR, storage: TL.STORAGE_FEE, loud: true }, {
    ok: true, settlement: 'settled', events: [ev('buy', { account: 'a.testnet', near_in: '1970000000000000000000000', storage_paid: '30000000000000000000000', tokens_out: (19_319_407n * UNIT).toString(), loud: false })],
  });
  assert.equal(buy.message, 'Bought 19,319,407 LOUD with 2.0000 NEAR, of which 0.03 NEAR registered this wallet with the token. The tokens are quiet: the launch window has closed, so they sell at once with Sell.');
  const buyNoEvent = TL.describeResult('buy', { accountId: 'a.testnet', call: 'buy', deposit: 2n * NEAR, loud: true }, { ok: true, settlement: 'settled', events: [] });
  assert.equal(buyNoEvent.message, 'The buy with 2.0000 NEAR went through. The explorer shows how many tokens arrived and whether they are loud.');

  // catch: amount, price, fee and what is left come from the event, not from the quote.
  const quoteCtx = { accountId: 'b.testnet', call: 'catch', amount: 4n * UNIT, exitId: '3', price: 5n * NEAR, fee: NEAR };
  const caught = TL.describeResult('catch', quoteCtx, {
    ok: true, settlement: 'settled', events: [ev('catch', { id: '3', account: 'a.testnet', catcher: 'b.testnet', amount: (2n * UNIT).toString(), remaining: (6n * UNIT).toString(), near_paid: NEAR.toString(), fee: (NEAR / 100n).toString() })],
  });
  assert.equal(caught.message, 'Caught 2 LOUD from exit 3 for 1.0000 NEAR. 0.010000 NEAR of it, the 1% fee, stays in the pool, and 0.9900 NEAR went to the seller. 6 LOUD are left in the exit. The tokens are loud in this wallet. The pool sold nothing and the cap was not used.');
  const caughtNoEvent = TL.describeResult('catch', quoteCtx, { ok: true, settlement: 'settled', events: [] });
  assert.match(caughtNoEvent.message, /^Caught LOUD from exit 3\. The explorer shows the amount and the price\./);
  assert.doesNotMatch(caughtNoEvent.message, /5\.0000|1\.0000/);

  // leave: a full fill closes the exit.
  const all = TL.describeResult('leave', { accountId: 'a.testnet', call: 'leave exit 3' }, {
    ok: true, settlement: 'settled', events: [ev('leave', { id: '3', account: 'a.testnet', filled: (5n * UNIT).toString(), remaining: '0', near_out: (NEAR / 2n).toString() })],
  });
  assert.equal(all.message, 'Sold 5 LOUD into the pool for 0.5000 NEAR. The exit is closed.');
  const leaveNoEvent = TL.describeResult('leave', { accountId: 'a.testnet', call: 'leave exit 3' }, { ok: true, value: '5', settlement: 'settled', events: [] });
  assert.equal(leaveNoEvent.message, 'The leave went through. The explorer shows how much was sold.');
});

test('results: a partial leave says why only when the state after it shows why', () => {
  const CAP = 5_000_000n * UNIT;
  // 949,050 LOUD filled while about 2.38M of cap room was left: the pool was short.
  assert.equal(TL.partialReason({ capAvailable: (1_435_232n * UNIT).toString(), capUnits: CAP.toString(), poolNear: '1000', quoteForRest: (NEAR / 10n).toString() }), 'pool');
  // The cap had (almost) no room left: a few seconds of refill at most.
  assert.equal(TL.partialReason({ capAvailable: (40_000n * UNIT).toString(), capUnits: CAP.toString(), poolNear: (50n * NEAR).toString(), quoteForRest: NEAR.toString() }), 'cap');
  // Room in the cap and NEAR in the pool: the reason is not known.
  assert.equal(TL.partialReason({ capAvailable: (1_000_000n * UNIT).toString(), capUnits: CAP.toString(), poolNear: (50n * NEAR).toString(), quoteForRest: NEAR.toString() }), null);
  assert.equal(TL.partialReason(null), null);

  const res = {
    ok: true, settlement: 'settled',
    events: [ev('leave', { id: '1', account: 'a.testnet', filled: (949_050n * UNIT).toString(), remaining: (13_000_000n * UNIT).toString(), near_out: (NEAR / 10n).toString() })],
  };
  const base = { accountId: 'a.testnet', call: 'leave exit 1' };
  const pool = TL.describeResult('leave', { ...base, after: { capAvailable: (1_435_232n * UNIT).toString(), capUnits: CAP.toString(), poolNear: '1000', quoteForRest: (NEAR / 10n).toString() } }, res);
  assert.equal(pool.message, 'Partial fill: 949,050 LOUD sold into the pool for 0.1000 NEAR; 13,000,000 LOUD stay in the exit. The pool held too little NEAR to pay for more.');
  assert.doesNotMatch(pool.message, /cap/);
  const cap = TL.describeResult('leave', { ...base, after: { capAvailable: '0', capUnits: CAP.toString(), poolNear: (50n * NEAR).toString(), quoteForRest: '0' } }, res);
  assert.match(cap.message, /stay in the exit\. The shared cap had no more room; press Leave again when it has refilled\.$/);
  const unknown = TL.describeResult('leave', base, res);
  assert.equal(unknown.message, 'Partial fill: 949,050 LOUD sold into the pool for 0.1000 NEAR; 13,000,000 LOUD stay in the exit.');
});

test('results: a failed payout is "recorded for claim", an unconfirmed receipt is not "paid"', () => {
  const catchEv = ev('catch', { id: '3', account: 'a.testnet', catcher: 'b.testnet', amount: (2n * UNIT).toString(), remaining: '0', near_paid: NEAR.toString(), fee: (NEAR / 100n).toString() });
  const ctx = { accountId: 'b.testnet', call: 'catch', exitId: '3' };
  const failed = TL.describeResult('catch', ctx, { ok: true, settled: false, settlement: 'payout_failed', payoutsFailed: [{ account: 'a.testnet', amount: (NEAR - NEAR / 100n).toString() }], events: [catchEv] });
  assert.match(failed.message, /0\.9900 NEAR is due to the seller\./);
  assert.match(failed.message, /A payout of 0\.990000 NEAR to a\.testnet came back\. The token recorded it as owed; that account can get it with claim\.$/);
  assert.doesNotMatch(failed.message, /went to the seller/);
  const own = TL.describeResult('leave', { accountId: 'a.testnet', call: 'leave exit 3' }, {
    ok: true, settled: false, settlement: 'payout_failed', payoutsFailed: [{ account: 'a.testnet', amount: (NEAR / 2n).toString() }],
    events: [ev('leave', { id: '3', account: 'a.testnet', filled: (5n * UNIT).toString(), remaining: '0', near_out: (NEAR / 2n).toString() })],
  });
  assert.match(own.message, /A payout of 0\.500000 NEAR to this wallet came back\. The token recorded it as owed; press Claim to get it\.$/);
  const unconfirmed = TL.describeResult('catch', ctx, { ok: true, settled: false, settlement: 'unconfirmed', payoutsFailed: [], events: [catchEv] });
  assert.match(unconfirmed.message, /is due to the seller/);
  assert.match(unconfirmed.message, /Not every receipt of this transaction succeeded, so a payment in it may not have arrived\./);
  assert.doesNotMatch(unconfirmed.message, /recorded it as owed/);
  const claim = TL.describeResult('claim', { accountId: 'a.testnet', call: 'claim' }, { ok: true, settlement: 'settled', events: [ev('claim', { account: 'a.testnet', amount: (NEAR / 2n).toString() })] });
  assert.equal(claim.message, 'Claimed 0.500000 NEAR that an earlier payout could not deliver. It is paid out again now.');
});

test('faucet refusal: its answer plus the address limit, and the second wallet comes from wallet A', () => {
  const msg = TL.faucetFailure(new Error('the testnet faucet refused to create x.testnet: helper.nearprotocol.com: HTTP 429 retry in 12 hours'));
  assert.match(msg, /HTTP 429 retry in 12 hours\. The public testnet faucet limits how many accounts one network address can create; try again later or from another network\. The simulator below works without it\.$/);
  const a = { accountId: 'loud-try-mwg2pcwu712bd7.testnet' };
  assert.equal(TL.secondWalletRoute(a, { exists: true, near: 10n * NEAR }), 'sub');
  assert.equal(TL.secondWalletRoute(a, { exists: true, near: 3n * NEAR }), 'faucet');
  assert.equal(TL.secondWalletRoute(a, null), 'faucet');
  assert.equal(TL.secondWalletRoute({ accountId: `${'x'.repeat(50)}.testnet` }, { exists: true, near: 10n * NEAR }), 'faucet');
});

test('board note and demo note come from what was read', () => {
  const live = {
    exits: [{}, {}], state: { open_exits: 2, is_loud_window: true }, block: { pinned: true, height: 123 }, readAtMs: Date.parse('2026-11-14T10:20:30Z'),
    params: { loud_until: 1_795_245_426_474_178_381n, notice_ns: 60_000_000_000n },
  };
  assert.equal(TL.boardNote(live), '2 open exits on the token, from every visitor, read page by page (100 a page) at block 123 from NEAR testnet at 10:20:30 UTC. The list may lag the chain by a few seconds. Times are UTC. The board reads again every 10 s.');
  assert.match(TL.boardNote({ ...live, exits: new Array(100).fill({}), state: { open_exits: 120 }, block: { pinned: false } }), /^The board shows 100 of the 120 open exits on the token, read page by page \(100 a page\) from/);
  const failed = TL.boardNote(live, 'HTTP 503');
  assert.equal(failed, 'Could not read the token just now (HTTP 503). The board below is the read of 10:20:30 UTC and may be out of date. The page tries again in 10 s.');
  assert.doesNotMatch(failed, /up to date/);
  assert.match(TL.demoNote(live), /^This token runs a demo setting\. Its launch window is open until 2026-11-21 07:17(:06)? UTC, so every buy until then is loud/);
  const closed = TL.demoNote({ ...live, state: { is_loud_window: false } });
  assert.match(closed, /Its launch window closed at 2026-11-21 .* UTC\. Buys are quiet now and sell at once with Sell/);
  assert.doesNotMatch(closed, /every buy until then is loud|Nobody holds quiet/);
  assert.match(closed, /The notice is 1 min here, against 30 min in the standard preset\.$/);
});

test('readLive pins every view of the token to the block of get_state, and falls back when it cannot', async () => {
  const exits = Array.from({ length: 2001 }, (_, i) => ({ id: String(i + 1), owner: `o${i}.testnet`, amount: '5', remaining: '5', shouted_at: '1', ready_at: '2', expires_at: '3' }));
  const seen = [];
  const chainAt = (failPinned) => ({
    viewAt: async (token, method, args, blockId = null) => {
      seen.push([method, blockId]);
      if (failPinned && blockId !== null) throw new Error('UNKNOWN_BLOCK');
      if (method === 'get_state') return { value: { open_exits: 2001, now: '1', is_loud_window: true }, blockHeight: 777 };
      if (method === 'get_params') return { value: { cap_units: '5' }, blockHeight: blockId };
      return { value: exits.slice(args.from_index, args.from_index + args.limit), blockHeight: blockId };
    },
    view: async (token, method, args) => (method === 'get_params' ? { cap_units: '5' } : exits.slice(args.from_index, args.from_index + args.limit)),
    accountState: async () => ({ exists: false, amountYocto: '0' }),
  });
  const live = await TL.readLive(chainAt(false), 't.testnet', []);
  assert.equal(live.exits.length, 2001, 'more than 20 pages are read');
  assert.equal(live.capped, false);
  assert.deepEqual(live.block, { pinned: true, height: 777 });
  assert.ok(seen.filter(([m]) => m !== 'get_state').every(([, b]) => b === 777));
  const loose = await TL.readLive(chainAt(true), 't.testnet', []);
  assert.equal(loose.block.pinned, false);
  assert.equal(loose.exits.length, 2001);
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
  // Mock hashes are invented: no explorer link.
  assert.equal(buy.explorerUrl, null);
  assert.match(buy.hash, /^[1-9A-HJ-NP-Za-km-z]{44}$/);
  assert.equal(chain.txUrl(buy.hash), null);
  assert.equal(chain.accountUrl(a.accountId), null);
  const bought = buy.events.find((e) => e.event === 'buy');
  assert.equal(bought.data.loud, true);
  assert.equal(bought.data.storage_paid, TL.STORAGE_FEE.toString());
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
  const told = TL.describeResult('leave', { accountId: a.accountId, call: `leave exit ${id}` }, leave);
  assert.match(told.message, /^Partial fill: /);
  const leftEv = leave.events.find((e) => e.event === 'leave');
  assert.equal(leftEv.data.filled, leave.value);
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
});

test('mock chain: the second wallet comes from wallet A, and a failed payout waits for claim', async () => {
  let ms = 0;
  const chain = TL.createMockChain({ nowMs: () => ms, payoutFails: true });
  const T = TL.MOCK_TOKEN;
  const a = await chain.createTestWallet({ prefix: 'loud-try' });
  const b = await chain.createSubWallet(a, { amountYocto: TL.SUB_WALLET_NEAR.toString() });
  assert.equal(b.outcome, 'success');
  assert.ok(b.accountId.endsWith(`.${a.accountId}`));
  assert.equal(b.explorerUrl, null);
  let live = await TL.readLive(chain, T, [a.accountId, b.accountId]);
  assert.equal(live.accounts[1].near, 3n * NEAR);
  assert.ok(live.accounts[0].near < 7n * NEAR);
  const plan = TL.buyPlan('2', live.accounts[0]);
  await chain.call(a, T, 'buy', TL.buyArgs(plan, await chain.view(T, 'quote_buy', { near: plan.intoPool.toString() })), { depositYocto: plan.deposit.toString() });
  live = await TL.readLive(chain, T, [a.accountId]);
  const shout = await chain.call(a, T, 'shout', { amount: live.accounts[0].loud.toString() }, { depositYocto: '1' });
  ms += 61_000;
  const leave = await chain.call(a, T, 'leave', { exit_id: shout.value, min_near_out: '0' }, { depositYocto: '1' });
  assert.equal(leave.ok, true);
  assert.equal(leave.settlement, 'payout_failed');
  assert.equal(leave.payoutsFailed[0].account, a.accountId);
  live = await TL.readLive(chain, T, [a.accountId]);
  const owed = live.accounts[0].owed;
  assert.ok(owed > 0n);
  assert.match(TL.describeResult('leave', { accountId: a.accountId, call: 'leave' }, leave).message, /press Claim to get it\.$/);
  const claim = await chain.call(a, T, 'claim', {}, { depositYocto: '1' });
  assert.equal(claim.ok, true);
  assert.equal(claim.value, owed.toString());
  assert.match(TL.describeResult('claim', { accountId: a.accountId, call: 'claim' }, claim).message, /^Claimed /);
  live = await TL.readLive(chain, T, [a.accountId]);
  assert.equal(live.accounts[0].owed, 0n);
  assert.equal((await chain.call(a, T, 'claim', {}, { depositYocto: '1' })).errorCode, 'E_NOTHING_OWED');
  // A wallet that cannot fund the second one is refused before anything moves.
  await assert.rejects(chain.createSubWallet(b, { amountYocto: (50n * NEAR).toString() }), /not have enough NEAR/);
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
  // The launch window is read from the chain; the static text does not claim it is open.
  assert.doesNotMatch(body, /every buy is loud|Nobody holds quiet/);
  assert.match(body, /<p class="mock-banner" id="try-mock" role="note" hidden><\/p>/);
  assert.equal(TL.MOCK_BANNER, 'MOCK: no chain, invented transactions');
  assert.match(body, /switching wallets and filling in amounts send nothing\./);
  assert.doesNotMatch(body, /Every button sends a transaction|A call takes 2 to 10 s/);
  assert.match(body, /up to about 2 minutes/);
  assert.match(body, /For a throwaway NEAR testnet account only\./);
  // Controls are hidden until the token has been read.
  assert.match(body, /<div id="try-app" hidden>/);
  // The simulator no longer reads as the product.
  assert.match(html, /<h2 id="sandbox-h">Simulator: play the rule by hand, no chain<\/h2>/);
  assert.match(html, /<a href="#try">Use it on testnet<\/a>/);
  // Chain data never goes through innerHTML.
  assert.ok(!/innerHTML/.test(app));
});

test('wallet storage helpers keep the key and format', () => {
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v) };
  assert.deepEqual(TL.loadWallets(storage), { wallets: [], active: 0 });
  const w = { accountId: 'a.testnet', publicKey: 'ed25519:11111111111111111111111111111111', secretKey: 'ed25519:x' };
  TL.saveWallets({ wallets: [w], active: 0 }, storage);
  assert.deepEqual([...mem.keys()], ['loud.live.wallets.v1']);
  assert.equal(mem.get('loud.live.wallets.v1'), TL.serializeWallets({ wallets: [w], active: 0 }));
  assert.deepEqual(TL.loadWallets(storage), TL.parseWallets(mem.get('loud.live.wallets.v1')));
});

test('a token chosen in the address: validated, its keys read from the chain, unknown on a failed read', async () => {
  assert.equal(TL.tokenFromSearch('?mock=1'), null);
  assert.equal(TL.tokenFromSearch('?token=T1.Alice.testnet'), 't1.alice.testnet');
  assert.deepEqual(TL.tokenFromSearch('?token=no%20spaces'), { invalid: 'no spaces' });
  const cfg = TL.configForToken('t1.alice.testnet', { token: 't.live.testnet' });
  assert.equal(cfg.defaultToken, 't.live.testnet');
  const chain = (exists, keys) => ({
    accountState: async () => ({ exists }),
    accessKeyList: async () => {
      if (keys instanceof Error) throw keys;
      return keys;
    },
  });
  assert.equal(await TL.readKeyCount(chain(true, []), cfg), 0);
  assert.equal(await TL.readKeyCount(chain(true, [{}, {}]), cfg), 2);
  // NEAR lists no keys for an account that does not exist: that is not "0 keys".
  assert.equal(await TL.readKeyCount(chain(false, []), cfg), null);
  assert.equal(await TL.readKeyCount(chain(true, new Error('fetch failed')), cfg), null);
  const mock = TL.createMockChain();
  const live = await TL.readLive(mock, TL.MOCK_TOKEN, []);
  const mcfg = TL.configForToken(TL.MOCK_TOKEN, { token: 'x.testnet' });
  assert.equal(TL.liveHeader(live, mcfg)[1][1], 'could not be read from NEAR testnet');
  await TL.readKeyCount(mock, mcfg);
  assert.equal(TL.liveHeader(live, mcfg)[1][1], '0. Nobody can sign for the token account.');
  assert.equal(TL.chosenTokenLine(live, mcfg), `You are looking at ${TL.MOCK_TOKEN}, launched by creator.testnet.`);
  assert.doesNotMatch(TL.demoNote(live, mcfg), /demo setting/);
  assert.match(TL.demoNote(live), /^This token runs a demo setting/);
});
