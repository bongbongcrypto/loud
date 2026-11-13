import test from 'node:test';
import assert from 'node:assert/strict';
import {
  YOCTO, ONE_TOKEN, nearToYocto, yoctoToNear, presetParams, splitEvenly, budget,
  failureText, errorCode, parseEvents, returnValueBigInt, leaveFilled, capBound, evaluateSplit,
  txLink, accountLink, jsonReplacer,
} from './lib.mjs';

const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64');

test('nearToYocto and yoctoToNear', () => {
  assert.equal(nearToYocto('1'), YOCTO);
  assert.equal(nearToYocto('0.5'), YOCTO / 2n);
  assert.equal(nearToYocto('0.000000000000000000000001'), 1n);
  assert.throws(() => nearToYocto('1e3'));
  assert.equal(yoctoToNear(YOCTO + YOCTO / 4n), '1.2500');
});

test('demo preset matches SPEC section 3', () => {
  const p = presetParams('demo', 'insider.x.testnet');
  assert.equal(p.total_supply, '1000000000000000000000000000');
  assert.equal(p.creator_alloc_bps, 500);
  assert.equal(p.virtual_near, '5000000000000000000000000');
  assert.equal(p.loud_window_ns, '120000000000');
  assert.equal(p.notice_ns, '60000000000');
  assert.equal(p.exit_window_ns, '600000000000');
  assert.equal(p.cap_bps, 50);
  assert.equal(p.cap_window_ns, '600000000000');
  assert.throws(() => presetParams('standard', 'x'));
});

test('splitEvenly keeps the exact total', () => {
  const parts = splitEvenly(1003n, 20);
  assert.equal(parts.length, 20);
  assert.equal(parts.reduce((a, b) => a + b, 0n), 1003n);
  assert.equal(parts[0], 50n);
  assert.equal(parts[19], 53n);
});

test('budget scales wallet funding and reports a shortfall', () => {
  const rich = budget({ wasmBytes: 300_000, balance: 100n * YOCTO });
  assert.equal(rich.ok, true);
  assert.equal(rich.perWallet, nearToYocto('0.25'));
  assert.equal(rich.tokenDeposit, nearToYocto('3.5'));
  const ten = budget({ wasmBytes: 300_000, balance: 10n * YOCTO });
  assert.equal(ten.ok, true);
  assert.ok(ten.perWallet >= nearToYocto('0.1') && ten.perWallet <= nearToYocto('0.25'));
  const total = ten.tokenDeposit + ten.insider + ten.late + ten.rootReserve + ten.perWallet * 20n;
  assert.ok(total <= 10n * YOCTO);
  const poor = budget({ wasmBytes: 300_000, balance: 5n * YOCTO });
  assert.equal(poor.ok, false);
  assert.ok(poor.need > 5n * YOCTO);
});

test('failureText and errorCode read a contract panic', () => {
  const failure = {
    ActionError: {
      index: 0,
      kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: E_NO_QUIET: loud 5, quiet 0; loud must use shout/leave' } },
    },
  };
  const text = failureText(failure);
  assert.match(text, /^E_NO_QUIET: loud 5, quiet 0/);
  assert.equal(errorCode(text), 'E_NO_QUIET');
  assert.equal(errorCode('Smart contract panicked: E_CAP: room returns in 3 s'), 'E_CAP');
  assert.equal(errorCode('E_NOTICE: 42 s left'), 'E_NOTICE');
  assert.equal(errorCode('InvalidNonce'), null);
  assert.equal(errorCode(null), null);
  assert.equal(failureText(undefined), null);
});

test('parseEvents accepts object and array data', () => {
  const logs = [
    'plain log',
    'EVENT_JSON:{"standard":"loud","version":"1.0.0","event":"leave","data":{"id":"1","filled":"7","remaining":"3"}}',
    'EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_transfer","data":[{"old_owner_id":"a","new_owner_id":"b","amount":"7"}]}',
    'EVENT_JSON:{broken',
  ];
  const evs = parseEvents(logs);
  assert.equal(evs.length, 2);
  assert.equal(evs[0].event, 'leave');
  assert.equal(evs[1].data.amount, '7');
});

test('leaveFilled prefers the event and falls back to the return value', () => {
  const logs = ['EVENT_JSON:{"standard":"loud","version":"1.0.0","event":"leave","data":[{"filled":"12","remaining":"0"}]}'];
  assert.deepEqual(leaveFilled({ logs, successValue: b64('99') }), { filled: 12n, remaining: 0n });
  assert.deepEqual(leaveFilled({ logs: [], successValue: b64('99') }), { filled: 99n, remaining: null });
  assert.deepEqual(leaveFilled({ logs: [], successValue: '' }), { filled: null, remaining: null });
  assert.equal(returnValueBigInt(b64(5)), 5n);
  assert.equal(returnValueBigInt(b64({ a: 1 })), null);
});

test('capBound follows SPEC invariant 4', () => {
  const capUnits = 5_000_000n * ONE_TOKEN;
  const w = 600n * 10n ** 9n;
  assert.equal(capBound({ bucketAtStart: 0n, capUnits, t0: 0n, t1: w, capWindowNs: w }), capUnits);
  assert.equal(capBound({ bucketAtStart: 10n, capUnits, t0: 100n, t1: 100n + w / 2n, capWindowNs: w }), 10n + capUnits / 2n);
  assert.equal(capBound({ bucketAtStart: 10n, capUnits, t0: 100n, t1: 50n, capWindowNs: w }), 10n);
});

test('evaluateSplit passes within the bound and fails above it', () => {
  const capUnits = 1000n;
  const w = 600n;
  const base = { bucketAtStart: 400n, capUnits, capWindowNs: w, t0: 1000n, t1: 1600n };
  const attempts = [
    { filled: '400', block_timestamp: '1001' },
    { filled: null, block_timestamp: '1001' },
    { filled: '500', block_timestamp: '1300' },
    { filled: '490', block_timestamp: '1599' },
  ];
  const ok = evaluateSplit({ ...base, attempts, totalLeftDelta: 1390n });
  assert.equal(ok.pass, true);
  assert.equal(ok.fills, 3);
  assert.equal(ok.soldInWindow, 1390n);
  assert.equal(ok.bound, 1400n);
  assert.equal(ok.receiptsMatchCounter, true);

  const over = evaluateSplit({ ...base, attempts, totalLeftDelta: 1401n });
  assert.equal(over.pass, false);
  assert.equal(over.receiptsMatchCounter, false);

  const none = evaluateSplit({ ...base, attempts: [], totalLeftDelta: 0n });
  assert.equal(none.pass, false);

  // A fill after the window end counts toward the total, not toward sold_in_window.
  const late = evaluateSplit({
    ...base, t1: 1700n,
    attempts: [...attempts, { filled: '100', block_timestamp: '1700' }],
    totalLeftDelta: null,
  });
  assert.equal(late.soldInWindow, 1390n);
  assert.equal(late.soldTotal, 1490n);
  assert.equal(late.pass, true);
});

test('links and replacer', () => {
  assert.equal(txLink('abc'), 'https://testnet.nearblocks.io/txns/abc');
  assert.equal(accountLink('t.x.testnet'), 'https://testnet.nearblocks.io/address/t.x.testnet');
  assert.equal(JSON.stringify({ a: 5n }, jsonReplacer), '{"a":"5"}');
});
