import test from 'node:test';
import assert from 'node:assert/strict';
import {
  YOCTO, ONE_TOKEN, nearToYocto, yoctoToNear, presetParams, splitEvenly, budget,
  failureText, errorCode, parseEvents, returnValueBigInt, leaveFilled, capBound, evaluateSplit,
  txLink, accountLink, jsonReplacer,
  receiptSettlement, base58Encode, isTxHash, faucetTx, paramMismatches,
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
    totalLeftDelta: 1490n,
  });
  assert.equal(late.soldInWindow, 1390n);
  assert.equal(late.soldTotal, 1490n);
  assert.equal(late.pass, true);
  assert.deepEqual(late.reasons, []);
});

test('evaluateSplit rejects weak evidence', () => {
  const base = { bucketAtStart: 400n, capUnits: 1000n, capWindowNs: 600n, t0: 1000n, t1: 1600n };
  const attempts = [
    { filled: '400', block_timestamp: '1001', settled: true },
    { filled: '500', block_timestamp: '1300', settled: true },
  ];
  const good = evaluateSplit({ ...base, attempts, totalLeftDelta: 900n });
  assert.equal(good.pass, true);
  assert.equal(good.fullWindow, true);
  assert.equal(good.timestampsValid, true);
  assert.equal(good.measuredNs, 600n);

  // The case from the review: no receipt evidence, a counter change of one, one time
  // unit measured against a sixty-unit window.
  const weak = evaluateSplit({ attempts: [], bucketAtStart: 10n, capUnits: 100n, capWindowNs: 60n, t0: 1000n, t1: 1001n, totalLeftDelta: 1n });
  assert.equal(weak.pass, false);
  assert.equal(weak.receiptsMatchCounter, false);
  assert.equal(weak.fullWindow, false);
  assert.equal(weak.fills, 0);

  // Each weakness alone is enough to fail.
  const noReceipts = evaluateSplit({ ...base, attempts: [], totalLeftDelta: 900n });
  assert.equal(noReceipts.pass, false);
  assert.equal(noReceipts.receiptsMatchCounter, false);

  const counterOff = evaluateSplit({ ...base, attempts, totalLeftDelta: 901n });
  assert.equal(counterOff.pass, false);
  assert.equal(counterOff.receiptsMatchCounter, false);

  const counterMissing = evaluateSplit({ ...base, attempts, totalLeftDelta: null });
  assert.equal(counterMissing.pass, false);
  assert.equal(counterMissing.receiptsMatchCounter, false);

  const oneUnit = evaluateSplit({ ...base, t1: 1001n, attempts: [{ filled: '1', block_timestamp: '1001' }], totalLeftDelta: 1n });
  assert.equal(oneUnit.receiptsMatchCounter, true);
  assert.equal(oneUnit.fullWindow, false);
  assert.equal(oneUnit.pass, false);

  const oneShort = evaluateSplit({ ...base, t1: 1599n, attempts, totalLeftDelta: 900n });
  assert.equal(oneShort.fullWindow, false);
  assert.equal(oneShort.pass, false);

  const noTime = evaluateSplit({ ...base, attempts: [attempts[0], { filled: '500', block_timestamp: null }], totalLeftDelta: 900n });
  assert.equal(noTime.timestampsValid, false);
  assert.equal(noTime.pass, false);

  const before = evaluateSplit({ ...base, attempts: [attempts[0], { filled: '500', block_timestamp: '999' }], totalLeftDelta: 900n });
  assert.equal(before.timestampsValid, false);
  assert.equal(before.pass, false);

  const after = evaluateSplit({ ...base, attempts: [attempts[0], { filled: '500', block_timestamp: '1601' }], totalLeftDelta: 900n });
  assert.equal(after.timestampsValid, false);
  assert.equal(after.pass, false);

  const emptyInterval = evaluateSplit({ ...base, t1: 1000n, attempts: [{ filled: '1', block_timestamp: '1000' }], totalLeftDelta: 1n });
  assert.equal(emptyInterval.timestampsValid, false);
  assert.equal(emptyInterval.pass, false);

  const unsettled = evaluateSplit({ ...base, attempts: [attempts[0], { ...attempts[1], settled: false }], totalLeftDelta: 900n });
  assert.equal(unsettled.unsettledFills, 1);
  assert.equal(unsettled.pass, false);
  assert.ok(unsettled.reasons.some((r) => r.includes('failed payout receipt')));
});

// A transaction result in the shape of RPC send_tx / tx with wait_until FINAL.
function txResult({ top = { SuccessValue: b64('7') }, receipts }) {
  return {
    status: top,
    transaction: { hash: 'x' },
    receipts_outcome: receipts.map(([id, executor, status, logs = []]) => ({ id, block_hash: 'b', outcome: { executor_id: executor, logs, status } })),
  };
}

test('receiptSettlement reads every receipt outcome, not only the top-level status', () => {
  const paid = receiptSettlement(txResult({
    receipts: [
      ['r1', 't.x.testnet', { SuccessValue: b64('7') }],
      ['r2', 'w01.x.testnet', { SuccessValue: '' }],
      ['r3', 'w01.x.testnet', { SuccessReceiptId: 'r9' }],
    ],
  }));
  assert.equal(paid.settled, true);
  assert.equal(paid.receipts, 3);
  assert.deepEqual(paid.failed, []);

  // The method succeeded, the detached transfer to the seller failed.
  const unpaid = receiptSettlement(txResult({
    receipts: [
      ['r1', 't.x.testnet', { SuccessValue: b64('7') }],
      ['r2', 'gone.x.testnet', { Failure: { ActionError: { index: 0, kind: { AccountDoesNotExist: { account_id: 'gone.x.testnet' } } } } }],
    ],
  }));
  assert.equal(unpaid.settled, false);
  assert.equal(unpaid.failed.length, 1);
  assert.equal(unpaid.failed[0].receipt_id, 'r2');
  assert.equal(unpaid.failed[0].executor, 'gone.x.testnet');
  assert.match(unpaid.failed[0].error, /AccountDoesNotExist/);

  // A contract panic fails at the top level and in its receipt.
  const panic = { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: E_CAP: room returns in 3 s' } } } };
  const rejected = receiptSettlement(txResult({ top: { Failure: panic }, receipts: [['r1', 't.x.testnet', { Failure: panic }]] }));
  assert.equal(rejected.settled, false);
  assert.match(rejected.failed[0].error, /^E_CAP/);

  // Nothing to inspect is not settled; neither is a receipt without a final status.
  assert.equal(receiptSettlement(txResult({ receipts: [] })).settled, false);
  assert.equal(receiptSettlement({}).settled, false);
  assert.equal(receiptSettlement(undefined).settled, false);
  assert.equal(receiptSettlement(txResult({ receipts: [['r1', 't.x.testnet', 'Unknown']] })).settled, false);
  assert.equal(receiptSettlement(txResult({ receipts: [['r1', 't.x.testnet', undefined]] })).settled, false);
});

test('receiptSettlement: the on_payout callback receipt, and a payout_failed event', () => {
  const ev = (standard, event, data) => `EVENT_JSON:${JSON.stringify({ standard, version: '1.0.0', event, data: [data] })}`;
  // A paid leave: the method, the transfer to the seller, the callback on the token, refunds.
  const paid = receiptSettlement(txResult({
    receipts: [
      ['r1', 't.x.testnet', { SuccessValue: b64('7') }, [ev('loud', 'leave', { filled: '7', remaining: '0' })]],
      ['r2', 'w01.x.testnet', { SuccessValue: '' }],
      ['r3', 't.x.testnet', { SuccessValue: '' }],
      ['r4', 'w01.x.testnet', { SuccessValue: '' }],
    ],
  }));
  assert.equal(paid.settled, true);
  assert.equal(paid.receipts, 4);
  assert.deepEqual(paid.failed, []);

  // The transfer failed and the callback recorded the debt: both receipts are reported.
  const failedEvent = ev('loud', 'payout_failed', { account: 'gone.x.testnet', amount: '123' });
  const unpaid = receiptSettlement(txResult({
    receipts: [
      ['r1', 't.x.testnet', { SuccessValue: b64('7') }],
      ['r2', 'gone.x.testnet', { Failure: { ActionError: { index: 0, kind: { AccountDoesNotExist: { account_id: 'gone.x.testnet' } } } } }],
      ['r3', 't.x.testnet', { SuccessValue: '' }, [failedEvent]],
    ],
  }));
  assert.equal(unpaid.settled, false);
  assert.deepEqual(unpaid.failed.map((f) => f.receipt_id), ['r2', 'r3']);
  assert.equal(unpaid.failed[1].error, 'payout_failed: 123 yoctoNEAR owed to gone.x.testnet');

  // The event alone is enough, even when every receipt status is a success.
  const eventOnly = receiptSettlement(txResult({
    receipts: [
      ['r1', 't.x.testnet', { SuccessValue: b64('7') }],
      ['r2', 't.x.testnet', { SuccessValue: '' }, ['a plain log line', failedEvent]],
    ],
  }));
  assert.equal(eventOnly.settled, false);
  assert.equal(eventOnly.failed.length, 1);
  assert.equal(eventOnly.failed[0].receipt_id, 'r2');
  assert.equal(eventOnly.failed[0].executor, 't.x.testnet');

  // Other events, another standard, and unreadable lines do not count as a failed payout.
  const other = receiptSettlement(txResult({
    receipts: [
      ['r1', 't.x.testnet', { SuccessValue: b64('7') }, [
        ev('loud', 'claim', { account: 'a.x.testnet', amount: '5' }),
        ev('nep141', 'payout_failed', { account: 'a.x.testnet', amount: '5' }),
        'EVENT_JSON:{not json',
        'payout_failed',
      ]],
    ],
  }));
  assert.equal(other.settled, true);
  assert.deepEqual(other.failed, []);
});

test('base58Encode gives NEAR hash text', () => {
  assert.equal(base58Encode(new Uint8Array(32)), '1'.repeat(32)); // the code hash of an account without code
  assert.equal(base58Encode(Buffer.from('Hello World!')), '2NEpo7TZRRrLZSi2U');
  assert.equal(base58Encode([0, 0, 1]), '112');
  assert.equal(base58Encode([]), '');
  const hash = base58Encode(Buffer.alloc(32, 0xff));
  assert.equal(isTxHash(hash), true);
});

test('faucetTx finds a transaction hash only where the faucet gives one', () => {
  const hash = base58Encode(Buffer.alloc(32, 7));
  assert.equal(isTxHash(hash), true);
  assert.equal(isTxHash('abc'), false);
  assert.equal(isTxHash(null), false);
  assert.equal(isTxHash(`${hash}0`), false); // 0 is not in the alphabet

  const full = faucetTx(JSON.stringify({
    status: { SuccessValue: b64(true) },
    transaction: { hash, signer_id: 'testnet', receiver_id: 'testnet' },
    transaction_outcome: { id: hash },
    receipts_outcome: [],
  }));
  assert.deepEqual(full, { hash, account: 'testnet', outcome: 'success', error: null });

  const failed = faucetTx(JSON.stringify({ status: { Failure: { ActionError: { kind: 'x' } } }, transaction_outcome: { id: hash } }));
  assert.equal(failed.hash, hash);
  assert.equal(failed.outcome, 'failure');
  assert.equal(failed.account, null);

  assert.deepEqual(faucetTx(JSON.stringify({ txHash: hash })), { hash, account: null, outcome: 'unknown', error: null });
  assert.deepEqual(faucetTx(JSON.stringify({ result: { transaction: { hash, signer_id: 'f.testnet' }, status: { SuccessValue: '' } } })),
    { hash, account: 'f.testnet', outcome: 'success', error: null });
  assert.deepEqual(faucetTx(JSON.stringify(hash)), { hash, account: null, outcome: 'unknown', error: null });

  assert.equal(faucetTx(''), null);
  assert.equal(faucetTx('<html><body>ok</body></html>'), null);
  assert.equal(faucetTx('{}'), null);
  assert.equal(faucetTx('null'), null);
  assert.equal(faucetTx('true'), null);
  assert.equal(faucetTx(JSON.stringify({ transaction: { hash: 'not-a-hash' } })), null);
  assert.equal(faucetTx(undefined), null);
});

test('paramMismatches compares get_params with the preset', () => {
  const intended = presetParams('demo', 'insider.x.testnet');
  const onchain = {
    total_supply: intended.total_supply,
    creator: 'insider.x.testnet',
    creator_alloc_bps: 500,
    virtual_near: intended.virtual_near,
    loud_window_ns: '120000000000',
    notice_ns: '60000000000',
    exit_window_ns: '600000000000',
    cap_bps: 50,
    cap_window_ns: '600000000000',
    launch_ts: '1794550000000000000',
    loud_until: '1794550120000000000',
    cap_units: (5_000_000n * ONE_TOKEN).toString(),
    creator_alloc: '0',
  };
  assert.deepEqual(paramMismatches(intended, onchain), []);

  const cap = paramMismatches(intended, { ...onchain, cap_bps: 5000 });
  assert.equal(cap.length, 1);
  assert.match(cap[0], /^cap_bps: intended 50, on chain 5000/);

  assert.match(paramMismatches(intended, { ...onchain, creator: 'other.testnet' })[0], /^creator:/);
  assert.match(paramMismatches(intended, { ...onchain, cap_units: '1' })[0], /^cap_units:/);
  assert.match(paramMismatches(intended, { ...onchain, loud_until: '1794550120000000001' })[0], /^loud_until:/);

  const missing = paramMismatches(intended, { ...onchain, notice_ns: undefined });
  assert.match(missing[0], /^notice_ns:/);

  // Nothing readable on chain: every key is reported.
  assert.equal(paramMismatches(intended, null).length, 11);
});

test('links and replacer', () => {
  assert.equal(txLink('abc'), 'https://testnet.nearblocks.io/txns/abc');
  assert.equal(accountLink('t.x.testnet'), 'https://testnet.nearblocks.io/address/t.x.testnet');
  assert.equal(JSON.stringify({ a: 5n }, jsonReplacer), '{"a":"5"}');
});
