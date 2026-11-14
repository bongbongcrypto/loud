import test from 'node:test';
import assert from 'node:assert/strict';
import {
  YOCTO, ONE_TOKEN, nearToYocto, yoctoToNear, presetParams, splitEvenly, budget, liveDocument,
  failureText, errorCode, parseEvents, returnValueBigInt, leaveFilled, capBound, evaluateSplit,
  txLink, accountLink, jsonReplacer,
  receiptSettlement, base58Encode, isTxHash, faucetTx, paramMismatches,
  txRecord, outcomeClass, needsLookup, unresolvedEarlier, leaveCounts, leaveCountsText, unresolvedSummary,
  STORAGE_MIN_YOCTO, decimalOrNull, buyEvent, evaluateBuy, tokenNear,
  CATCH_FEE_BPS, catchEvent, catchDeposit, evaluateCatch,
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
  assert.equal(rich.perWallet, nearToYocto('0.28'));
  assert.equal(rich.registration, STORAGE_MIN_YOCTO);
  assert.equal(rich.tokenDeposit, nearToYocto('3.5'));
  const ten = budget({ wasmBytes: 300_000, balance: 10n * YOCTO });
  assert.equal(ten.ok, true);
  // Every wallet gets its registration payment on top of the NEAR it needs for gas.
  assert.ok(ten.perWallet >= nearToYocto('0.13') && ten.perWallet <= nearToYocto('0.28'));
  const total = ten.tokenDeposit + ten.insider + ten.late + ten.rootReserve + ten.perWallet * 20n;
  assert.ok(total <= 10n * YOCTO);
  const poor = budget({ wasmBytes: 300_000, balance: 5n * YOCTO });
  assert.equal(poor.ok, false);
  assert.ok(poor.need > 5n * YOCTO);
  // 3.5 token + 1.25 insider + 0.65 late + 0.3 root + 20 * (0.1 gas + 0.03 registration)
  assert.equal(poor.need, nearToYocto('8.3'));
});

test('STORAGE_MIN_YOCTO is 0.03 NEAR', () => {
  assert.equal(STORAGE_MIN_YOCTO, nearToYocto('0.03'));
  assert.equal(STORAGE_MIN_YOCTO.toString(), '30000000000000000000000');
});

test('errorCode keeps the codes of this run apart', () => {
  assert.equal(errorCode('E_NOTICE: 55 s of notice left'), 'E_NOTICE');
  assert.equal(errorCode('E_NOTICE_BINDING: a shout is binding until the exit expires'), 'E_NOTICE_BINDING');
  assert.equal(errorCode('E_UNREGISTERED: w01.x.testnet is not registered'), 'E_UNREGISTERED');
  const panic = { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: E_NOTICE_BINDING: wait' } } } };
  assert.equal(errorCode(failureText(panic)), 'E_NOTICE_BINDING');
});

test('buyEvent reads the buy event and leaves absent fields null', () => {
  const line = (data) => `EVENT_JSON:${JSON.stringify({ standard: 'loud', version: '1.0.0', event: 'buy', data: [data] })}`;
  const full = buyEvent([
    'EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_transfer","data":[{"amount":"5"}]}',
    line({ account: 'a.testnet', near_in: '470000000000000000000000', storage_paid: '30000000000000000000000', tokens_out: '77', loud: false }),
  ]);
  assert.deepEqual(full, { nearIn: nearToYocto('0.47'), storagePaid: STORAGE_MIN_YOCTO, tokensOut: 77n, loud: false });
  const old = buyEvent([line({ account: 'a.testnet', near_in: '1000', tokens_out: '5', loud: true })]);
  assert.equal(old.storagePaid, null);
  assert.equal(old.nearIn, 1000n);
  assert.equal(buyEvent([line({ near_in: 'abc', storage_paid: -1 })]).nearIn, null);
  assert.equal(buyEvent([line({ near_in: 'abc', storage_paid: -1 })]).storagePaid, null);
  assert.equal(buyEvent(['plain log']), null);
  assert.equal(buyEvent(undefined), null);
  assert.equal(decimalOrNull('12'), 12n);
  assert.equal(decimalOrNull(12), 12n);
  assert.equal(decimalOrNull('1.5'), null);
  assert.equal(decimalOrNull(null), null);
});

test('evaluateBuy: a first buy pays the registration out of the deposit', () => {
  const half = nearToYocto('0.5');
  const net = nearToYocto('0.47');
  const event = { nearIn: net, storagePaid: STORAGE_MIN_YOCTO, tokensOut: 1n, loud: false };
  const first = evaluateBuy({ attached: half, registeredBefore: false, poolNearBefore: '1000', poolNearAfter: (1000n + net).toString(), event });
  assert.equal(first.pass, true);
  assert.deepEqual(first.reasons, []);
  assert.deepEqual(first.notes, []);
  assert.deepEqual(first.record, {
    attached: half.toString(),
    registered_before: false,
    expected_storage_paid: STORAGE_MIN_YOCTO.toString(),
    expected_near_in: net.toString(),
    pool_near_before: '1000',
    pool_near_after: (1000n + net).toString(),
    pool_near_change: net.toString(),
    event_near_in: net.toString(),
    event_storage_paid: STORAGE_MIN_YOCTO.toString(),
    pass: true,
  });

  // The whole deposit in the pool: the registration was not taken.
  const untaken = evaluateBuy({ attached: half, registeredBefore: false, poolNearBefore: 0n, poolNearAfter: half, event });
  assert.equal(untaken.pass, false);
  assert.match(untaken.reasons.join(' '), /pool_near changed by/);

  // A registered account pays nothing for storage.
  const one = nearToYocto('1');
  const again = evaluateBuy({
    attached: one, registeredBefore: true, poolNearBefore: '0', poolNearAfter: one.toString(),
    event: { nearIn: one, storagePaid: 0n, tokensOut: 1n, loud: true },
  });
  assert.equal(again.pass, true);
  assert.equal(again.record.expected_storage_paid, '0');
  assert.equal(again.record.event_storage_paid, '0');
  // Charging a registered account a second time fails the check.
  const twice = evaluateBuy({ attached: one, registeredBefore: true, poolNearBefore: '0', poolNearAfter: (one - STORAGE_MIN_YOCTO).toString(), event: null });
  assert.equal(twice.pass, false);
});

test('evaluateBuy: the event is evidence, the pool change decides', () => {
  const half = nearToYocto('0.5');
  const net = nearToYocto('0.47');
  const base = { attached: half, registeredBefore: false, poolNearBefore: 0n, poolNearAfter: net };
  // An absent event or an absent field is named, and does not fail the check.
  const noEvent = evaluateBuy({ ...base, event: null });
  assert.equal(noEvent.pass, true);
  assert.deepEqual(noEvent.notes, ['no buy event was read']);
  const noField = evaluateBuy({ ...base, event: { nearIn: net, storagePaid: null, tokensOut: 1n, loud: false } });
  assert.equal(noField.pass, true);
  assert.deepEqual(noField.notes, ['the buy event has no storage_paid']);
  assert.equal(noField.record.event_storage_paid, null);
  // A field that is present and wrong fails it.
  const wrongIn = evaluateBuy({ ...base, event: { nearIn: half, storagePaid: STORAGE_MIN_YOCTO, tokensOut: 1n, loud: false } });
  assert.equal(wrongIn.pass, false);
  assert.match(wrongIn.reasons.join(' '), /near_in/);
  const wrongPaid = evaluateBuy({ ...base, event: { nearIn: net, storagePaid: 0n, tokensOut: 1n, loud: false } });
  assert.equal(wrongPaid.pass, false);
  assert.match(wrongPaid.reasons.join(' '), /storage_paid/);
  // Without the reads there is no verdict in favour.
  const unread = evaluateBuy({ attached: half, registeredBefore: undefined, poolNearBefore: null, poolNearAfter: null, event: null });
  assert.equal(unread.pass, false);
  assert.equal(unread.reasons.length, 2);
  assert.equal(unread.record.registered_before, null);
  assert.equal(unread.record.pool_near_change, null);
});

test('tokenNear splits the balance of the token account', () => {
  const sheet = tokenNear({
    balance: nearToYocto('4'),
    storageBytes: 230_000,
    poolNear: nearToYocto('1.2'),
    owedTotal: '0',
  });
  assert.deepEqual(sheet, {
    balance: nearToYocto('4').toString(),
    pool_near: nearToYocto('1.2').toString(),
    owed_total: '0',
    spare: nearToYocto('2.8').toString(),
    storage_bytes: 230_000,
    storage_stake: nearToYocto('2.3').toString(),
    free: nearToYocto('0.5').toString(),
  });
  // A balance that does not cover pool, debts and storage shows as a negative `free`.
  const short = tokenNear({ balance: nearToYocto('3'), storageBytes: 230_000, poolNear: nearToYocto('1'), owedTotal: nearToYocto('0.1') });
  assert.equal(short.spare, nearToYocto('2').toString());
  assert.equal(short.free, `-${nearToYocto('0.4')}`);
});

test('txRecord names the contract method of a function call', () => {
  const rec = txRecord({ hash: 'h', account: 'a.testnet', outcome: 'success', error: null, method: 'storage_deposit' });
  assert.equal(rec.call, 'storage_deposit');
  assert.equal('call' in txRecord({ hash: 'h', account: 'a.testnet', outcome: 'success', error: null }), false);
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

  // No receipt evidence, a counter change of one, one time
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

test('txRecord keeps the hash of every earlier broadcast', () => {
  const h1 = base58Encode(Buffer.alloc(32, 1));
  const h2 = base58Encode(Buffer.alloc(32, 2));
  const h3 = base58Encode(Buffer.alloc(32, 3));

  // A send that went through on the first broadcast: the record has the four base keys only.
  const plain = txRecord({ hash: h1, account: 'w01.x.testnet', outcome: 'success', error: null, earlierAttempts: [] });
  assert.deepEqual(plain, { hash: h1, account: 'w01.x.testnet', outcome: 'success', error: null });
  assert.deepEqual(txRecord({ hash: h1, account: 'a', outcome: 'success', error: null }),
    { hash: h1, account: 'a', outcome: 'success', error: null });

  // Two broadcasts were refused (InvalidNonce, Expired) before the third went through.
  const sent = { hash: h3, account: 'w02.x.testnet', outcome: 'success', error: null, earlierAttempts: [h1, h2] };
  const retried = txRecord(sent, { round: 2 });
  assert.deepEqual(retried, {
    hash: h3, account: 'w02.x.testnet', outcome: 'success', error: null, round: 2, earlier_attempts: [h1, h2],
  });
  retried.earlier_attempts.push('x');
  assert.deepEqual(sent.earlierAttempts, [h1, h2]); // the record holds a copy

  // The last attempt failed before it was broadcast: no hash of its own, the earlier one stays.
  const lost = txRecord({ hash: null, account: 'w03.x.testnet', outcome: 'unknown', error: 'rpc: block failed', earlierAttempts: [h1] });
  assert.equal(lost.hash, null);
  assert.deepEqual(lost.earlier_attempts, [h1]);
  assert.equal(outcomeClass(lost), 'not_executed'); // this attempt was never broadcast
  assert.deepEqual(unresolvedEarlier(lost), [h1]); // the earlier broadcast has not been looked up

  // After the lookup: found on chain, not found, or the lookup itself failed.
  const looked = {
    ...retried,
    earlier_attempts: [h1, h2],
    earlier_attempt_outcomes: [{ hash: h1, outcome: 'invalid', error: 'refused' }, { hash: h2, outcome: 'unknown', error: 'rpc down' }],
  };
  assert.deepEqual(unresolvedEarlier(looked), [h2]);
  looked.earlier_attempt_outcomes[1] = { hash: h2, outcome: 'failure', error: 'E_CAP: room returns in 3 s' };
  assert.deepEqual(unresolvedEarlier(looked), []);
  assert.deepEqual(unresolvedEarlier(plain), []);
});

test('outcomeClass and needsLookup keep unknown apart from not executed', () => {
  const hash = base58Encode(Buffer.alloc(32, 9));
  assert.equal(outcomeClass({ hash, outcome: 'success' }), 'success');
  assert.equal(outcomeClass({ hash, outcome: 'failure' }), 'executed_failed');
  assert.equal(outcomeClass({ hash, outcome: 'invalid' }), 'not_executed');
  assert.equal(outcomeClass({ hash, outcome: 'unknown' }), 'unresolved');
  assert.equal(outcomeClass({ hash: null, outcome: 'unknown' }), 'not_executed');
  assert.equal(outcomeClass({ hash, outcome: 'something else' }), 'unresolved');
  assert.equal(outcomeClass(null), 'not_executed');

  assert.equal(needsLookup({ hash, outcome: 'unknown', error: 'was not final after 120s' }), true);
  assert.equal(needsLookup({ hash: null, outcome: 'unknown', error: 'x' }), false);
  assert.equal(needsLookup({ hash, outcome: 'invalid', error: '{"InvalidTransaction":{"InvalidNonce":{"tx_nonce":5,"ak_nonce":5}}}' }), true);
  assert.equal(needsLookup({ hash, outcome: 'invalid', error: 'NotEnoughBalance' }), false);
  assert.equal(needsLookup({ hash, outcome: 'success', error: null }), false);
  assert.equal(needsLookup({ hash, outcome: 'failure', error: 'E_CAP' }), false);
});

test('leaveCounts keeps executed-and-failed, not executed and unresolved apart', () => {
  const h = (n) => base58Encode(Buffer.alloc(32, n));
  const attempts = [
    { hash: h(1), outcome: 'success', filled: '500', error_code: null, settled: true },
    { hash: h(2), outcome: 'success', filled: '300', error_code: null, settled: false },
    { hash: h(3), outcome: 'failure', filled: null, error_code: 'E_CAP', settled: null },
    { hash: h(4), outcome: 'failure', filled: null, error_code: 'E_CAP', settled: null },
    { hash: h(5), outcome: 'failure', filled: null, error_code: 'E_EXPIRED', settled: null },
    { hash: h(6), outcome: 'failure', filled: null, error_code: 'E_NOT_OWNER', settled: null },
    { hash: h(7), outcome: 'invalid', filled: null, error_code: null, settled: null },
    { hash: null, outcome: 'unknown', filled: null, error_code: null, settled: null }, // never broadcast
    { hash: h(8), outcome: 'unknown', filled: null, error_code: null, settled: null },
    { hash: h(9), outcome: 'unknown', filled: null, error_code: null, settled: null, earlier_attempts: [h(10), h(11)] },
  ];
  const c = leaveCounts(attempts);
  assert.deepEqual(c, {
    calls: 10,
    fills: 2,
    cap_hits: 2,
    expired: 1,
    other_failures: 1,
    executed_failed: 4,
    not_executed: 2,
    unresolved: 2,
    payout_calls: 2,
    payouts_settled: 1,
    earlier_attempts: 2,
  });
  // Every call is in exactly one group.
  assert.equal(c.payout_calls + c.executed_failed + c.not_executed + c.unresolved, c.calls);

  const text = leaveCountsText(c, 20);
  assert.match(text, /^10 leave calls from 20 wallets: 2 filled; /);
  assert.match(text, /4 executed and failed \(2 E_CAP, 1 E_EXPIRED, 1 other\); /);
  assert.match(text, /2 not executed \(refused before execution or never broadcast\); /);
  assert.match(text, /2 unresolved \(broadcast, outcome not confirmed by polling or by the later lookup by hash\)/);
  assert.match(text, /; earlier broadcasts replaced by a retry and listed as earlier_attempts: 2; /);
  assert.match(text, /1 of 2 successful leaves have no failed receipt and no payout_failed event$/);

  // The shape of the saved run: unknown calls are unresolved, and none is "not executed".
  const saved = leaveCounts([
    { hash: h(1), outcome: 'success', filled: '7', error_code: null, settled: true },
    { hash: h(2), outcome: 'failure', filled: null, error_code: 'E_CAP', settled: null },
    { hash: h(3), outcome: 'unknown', filled: null, error_code: null, settled: null },
  ]);
  assert.equal(saved.unresolved, 1);
  assert.equal(saved.not_executed, 0);
  const savedText = leaveCountsText(saved, 20);
  assert.match(savedText, /0 not executed/);
  assert.match(savedText, /1 unresolved/);
  assert.doesNotMatch(savedText, /earlier broadcasts/);

  assert.equal(leaveCounts([]).calls, 0);
});

test('unresolvedSummary counts what the run sent and could not confirm', () => {
  const h = (n) => base58Encode(Buffer.alloc(32, n));
  const none = unresolvedSummary([
    { hash: h(1), outcome: 'success', error: null },
    { hash: h(2), outcome: 'failure', error: 'E_CAP' },
    { hash: h(3), outcome: 'invalid', error: 'NotEnoughBalance' },
    { hash: null, outcome: 'unknown', error: 'never broadcast' },
  ]);
  assert.deepEqual(none, { count: 0, hashes: [], note: null });
  assert.deepEqual(unresolvedSummary([]), { count: 0, hashes: [], note: null });
  assert.deepEqual(unresolvedSummary(null), { count: 0, hashes: [], note: null });

  const one = unresolvedSummary([{ hash: h(1), outcome: 'success' }, { hash: h(4), outcome: 'unknown' }]);
  assert.equal(one.count, 1);
  assert.deepEqual(one.hashes, [h(4)]);
  assert.match(one.note, /^1 transaction that the run sent has no confirmed outcome/);
  assert.match(one.note, /not known whether it never executed or executed and failed/);
  assert.match(one.note, /rests on the contract counter, not on these statuses\.$/);

  // Earlier broadcasts count too: one without a lookup result, one whose lookup failed.
  const many = unresolvedSummary([
    { hash: h(4), outcome: 'unknown' },
    { hash: h(5), outcome: 'success', earlier_attempts: [h(6)] },
    {
      hash: h(7), outcome: 'success', earlier_attempts: [h(8), h(9)],
      earlier_attempt_outcomes: [{ hash: h(8), outcome: 'invalid', error: 'refused' }, { hash: h(9), outcome: 'unknown', error: 'rpc down' }],
    },
  ]);
  assert.equal(many.count, 3);
  assert.deepEqual(many.hashes, [h(4), h(6), h(9)]);
  assert.match(many.note, /^3 transactions that the run sent have no confirmed outcome/);
  assert.match(many.note, /each of them never executed or executed and failed/);
});

// A catch of 400 units at a quote of 1,000 yoctoNEAR (fee 10) as the contract reports it.
const catchLog = (data) => `EVENT_JSON:${JSON.stringify({ standard: 'loud', version: '1.0.0', event: 'catch', data: [data] })}`;
const goodCatch = () => ({
  amount: 400n,
  quote: { near_in: '1000', fee: '10' },
  outcome: 'success',
  settled: true,
  returned: 400n,
  catcherBefore: { loud: '0', quiet: '77' },
  catcherAfter: { loud: '400', quiet: '77' },
  remainingBefore: 1600n,
  remainingAfter: 1200n,
  stateBefore: { pool_tokens: '9000', pool_near: '500', cap_available: '30', total_caught: '0', catch_count: 0 },
  stateAfter: { pool_tokens: '9000', pool_near: '510', cap_available: '42', total_caught: '400', catch_count: 1 },
  event: catchEvent([catchLog({ id: '12', account: 'w02.x', catcher: 'late.x', amount: '400', remaining: '1200', near_paid: '1000', fee: '10' })]),
});

test('catchEvent reads the loud catch event and nothing else', () => {
  assert.equal(catchEvent([]), null);
  assert.equal(catchEvent(['EVENT_JSON:{"standard":"loud","version":"1.0.0","event":"leave","data":[{"filled":"1"}]}']), null);
  const ev = catchEvent(['noise', catchLog({ id: 12, account: 'w02.x', catcher: 'late.x', amount: '400', remaining: '0', near_paid: '1000', fee: '10' })]);
  assert.deepEqual(ev, { id: '12', owner: 'w02.x', catcher: 'late.x', amount: 400n, remaining: 0n, nearPaid: 1000n, fee: 10n });
  const bare = catchEvent([catchLog({})]);
  assert.deepEqual(bare, { id: null, owner: null, catcher: null, amount: null, remaining: null, nearPaid: null, fee: null });
});

test('catchDeposit adds a margin and rounds it up', () => {
  assert.equal(catchDeposit('1000'), 1050n);
  assert.equal(catchDeposit(1n), 2n);
  assert.equal(catchDeposit('0'), 0n);
  assert.equal(catchDeposit(21_000_000_000_000_000_000_000n), 22_050_000_000_000_000_000_000n);
  assert.equal(catchDeposit('1000', 0n), 1000n);
});

test('CATCH_FEE_BPS is 1%', () => {
  assert.equal(CATCH_FEE_BPS, 100n);
});

test('evaluateCatch: a catch that follows the rule passes', () => {
  const r = evaluateCatch(goodCatch());
  assert.equal(r.pass, true);
  assert.deepEqual(r.reasons, []);
  assert.deepEqual(r.notes, []);
  assert.deepEqual(r.record, {
    amount: '400', quote_near_in: '1000', quote_fee: '10', near_in: '1000', fee: '10',
    catcher_loud_before: '0', catcher_loud_after: '400', catcher_quiet_before: '77', catcher_quiet_after: '77',
    remaining_before: '1600', remaining_after: '1200',
    pool_tokens_change: '0', pool_near_change: '10', cap_available_before: '30', cap_available_after: '42',
    total_caught_change: '400', catch_count_change: '1', settled: true, pass: true,
  });
  // The whole exit caught: the caller passes 0 for an exit that is gone.
  const all = goodCatch();
  Object.assign(all, { amount: 1600n, returned: 1600n, remainingAfter: 0n, catcherAfter: { loud: '1600', quiet: '77' } });
  all.stateAfter.total_caught = '1600';
  all.event = catchEvent([catchLog({ amount: '1600', remaining: '0', near_paid: '1000', fee: '10' })]);
  assert.equal(evaluateCatch(all).pass, true);
});

test('evaluateCatch: each broken condition fails with its reason', () => {
  const broken = (change, pattern) => {
    const input = goodCatch();
    change(input);
    const r = evaluateCatch(input);
    assert.equal(r.pass, false, String(pattern));
    assert.equal(r.record.pass, false);
    assert.ok(r.reasons.some((x) => pattern.test(x)), `${pattern} not in ${JSON.stringify(r.reasons)}`);
  };
  broken((i) => { i.outcome = 'failure'; }, /did not succeed \(failure\)/);
  broken((i) => { i.outcome = 'unknown'; }, /did not succeed \(unknown\)/);
  broken((i) => { i.settled = false; }, /receipt of the catch failed/);
  broken((i) => { i.returned = 399n; }, /returned 399, expected 400/);
  broken((i) => { i.catcherAfter.loud = '399'; }, /loud balance changed by 399, expected 400/);
  // Caught tokens must not arrive as quiet.
  broken((i) => { i.catcherAfter = { loud: '0', quiet: '477' }; }, /quiet balance changed by 400/);
  broken((i) => { i.remainingAfter = 1600n; }, /remaining fell by 0, expected 400/);
  broken((i) => { i.stateAfter.pool_tokens = '9400'; }, /pool_tokens changed by 400/);
  // The whole payment in the pool instead of the fee only.
  broken((i) => { i.stateAfter.pool_near = '1500'; }, /pool_near changed by 1000, expected the fee 10/);
  broken((i) => { i.stateAfter.pool_near = '500'; }, /pool_near changed by 0, expected the fee 10/);
  broken((i) => { i.stateAfter.cap_available = '29'; }, /cap_available fell by 1/);
  broken((i) => { i.stateAfter.total_caught = '0'; }, /total_caught changed by 0/);
  broken((i) => { i.stateAfter.catch_count = 0; }, /catch_count changed by 0/);
  broken((i) => { delete i.stateBefore.total_caught; }, /no total_caught/);
  broken((i) => { i.stateBefore = null; }, /get_state was not read/);
  broken((i) => { i.catcherBefore = null; }, /catcher balances were not read/);
  broken((i) => { i.remainingBefore = null; }, /exit was not read/);
  broken((i) => { i.event.amount = 1n; }, /event says amount 1/);
  broken((i) => { i.event.fee = 11n; i.stateAfter.pool_near = '511'; }, /1% rounded down is 10/);
  broken((i) => { i.event.remaining = 5n; }, /event says remaining 5/);
});

test('evaluateCatch: a missing event or quote is a note, and the other one supplies the fee', () => {
  const noEvent = goodCatch();
  noEvent.event = null;
  const a = evaluateCatch(noEvent);
  assert.equal(a.pass, true);
  assert.deepEqual(a.notes, ['no catch event was read']);
  assert.equal(a.record.fee, '10');
  const noQuote = goodCatch();
  noQuote.quote = null;
  const b = evaluateCatch(noQuote);
  assert.equal(b.pass, true);
  assert.deepEqual(b.notes, ['quote_catch was not read']);
  const neither = goodCatch();
  neither.quote = null;
  neither.event = null;
  const c = evaluateCatch(neither);
  assert.equal(c.pass, false);
  assert.ok(c.reasons.some((x) => /no fee to compare/.test(x)));
  // The price moved between the view and the call: the event decides, the quote is a note.
  const moved = goodCatch();
  moved.quote = { near_in: '990', fee: '9' };
  const d = evaluateCatch(moved);
  assert.equal(d.pass, true);
  assert.ok(d.notes.some((x) => /price moved/.test(x)));
  assert.equal(d.record.near_in, '1000');
  // A call that failed has nothing to settle.
  const failed = goodCatch();
  failed.outcome = 'failure';
  assert.equal(evaluateCatch(failed).record.settled, null);
});

test('live preset: 7 day launch window, no creator allocation, inside the contract bounds', () => {
  const p = presetParams('live', 'loud-live-x.testnet');
  assert.equal(p.creator, 'loud-live-x.testnet');
  assert.equal(p.creator_alloc_bps, 0);
  assert.equal(p.loud_window_ns, (7n * 24n * 3600n * 10n ** 9n).toString());
  assert.equal(p.notice_ns, (60n * 10n ** 9n).toString());
  assert.equal(p.exit_window_ns, (1800n * 10n ** 9n).toString());
  assert.equal(p.cap_bps, 50);
  assert.equal(p.cap_window_ns, (600n * 10n ** 9n).toString());
  assert.equal(p.virtual_near, (100n * YOCTO).toString());
  // The same keys as the demo preset, so that `new` takes both.
  assert.deepEqual(Object.keys(p), Object.keys(presetParams('demo', 'x.testnet')));
  // A 2 NEAR buy on an empty pool gives more than one cap (5,000,000 LOUD): a leave is partial.
  const out = (1_000_000_000n * ONE_TOKEN) * (2n * YOCTO) / (100n * YOCTO + 2n * YOCTO);
  assert.ok(out > 5_000_000n * ONE_TOKEN);
});

test('liveDocument: ok only with a transaction, no key, the built code and the preset', () => {
  const base = {
    token: 't.loud-live-x.testnet', root: 'loud-live-x.testnet', params: presetParams('live', 'loud-live-x.testnet'),
    onchain: { loud_until: '1794600000000000000' }, tx: 'A'.repeat(44), keys: [], codeHash: 'HASH', expectedCodeHash: 'HASH',
    mismatches: [], deployTsNs: 1793995200000000000n, wasm: { bytes: 1, sha256: 'x' }, run: { commit: 'abc' }, now: '2026-11-14T08:00:00.000Z',
  };
  const ok = liveDocument(base);
  assert.equal(ok.status, 'ok');
  assert.equal(ok.preset, 'live');
  assert.equal(ok.zero_keys, true);
  assert.equal(ok.creator_account, 'loud-live-x.testnet');
  assert.equal(ok.deployed_at, new Date(1793995200000).toISOString());
  assert.equal(ok.loud_until, new Date(1794600000000).toISOString());
  assert.equal(ok.explorer.tx, `https://testnet.nearblocks.io/txns/${'A'.repeat(44)}`);
  assert.doesNotThrow(() => JSON.stringify(ok));
  assert.equal(liveDocument({ ...base, keys: ['ed25519:x'] }).status, 'failed');
  assert.equal(liveDocument({ ...base, codeHash: 'OTHER' }).status, 'failed');
  assert.equal(liveDocument({ ...base, mismatches: ['cap_bps'] }).status, 'failed');
  assert.equal(liveDocument({ ...base, tx: null }).status, 'failed');
  const early = liveDocument({ ...base, onchain: null, keys: null, mismatches: null, deployTsNs: null });
  assert.equal(early.status, 'failed');
  assert.equal(early.loud_until, null);
  assert.equal(early.deployed_at, null);
});
