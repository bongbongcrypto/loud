import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as W from './wallet-connect.js';
import * as C from './chain.js';
import * as TL from './live-ui.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`../scripts/fixtures/${name}.json`, import.meta.url), 'utf8'));
const BUY = fixture('tx-buy-success');
const SELL = fixture('tx-sell-failure');
const SENDER = BUY.transaction.signer_id;

// A wallet whose signAndSendTransaction does what `answer` says, and a chain whose
// txStatus reads the recorded RPC answers through chain.js's own parser.
function setup(answer, { lookup = true } = {}) {
  const asked = [];
  const looked = [];
  const wallet = {
    manifest: { id: 'w', name: 'Some Wallet' },
    getAccounts: async () => [{ accountId: SENDER }],
    signAndSendTransaction: async (p) => {
      asked.push(p);
      return answer(p);
    },
  };
  const byHash = new Map([[BUY.transaction.hash, BUY], [SELL.transaction.hash, SELL]]);
  const chain = {
    txUrl: C.txUrl,
    async txStatus(hash, sender) {
      looked.push([hash, sender]);
      if (!lookup || !byHash.has(hash)) return null;
      return { ...C.summarizeResult(byHash.get(hash), hash), refusedHash: null, signedHashes: [hash] };
    },
  };
  const conn = { kind: 'connected', accountId: SENDER, walletName: 'Some Wallet', wallet };
  return { conn, chain, asked, looked };
}

const send = (s, opts = {}) => W.callWith(s.chain, s.conn, 't.loud.testnet', 'buy', { min_tokens_out: '1' }, { gasTgas: 100, depositYocto: '2000000000000000000000000' }, opts);

test('the wallet is asked with testnet, the signer, gas in gas units and the deposit in yocto', async () => {
  const s = setup(() => ({ transaction: { hash: BUY.transaction.hash } }));
  await send(s);
  assert.deepEqual(s.asked, [{
    network: 'testnet',
    signerId: SENDER,
    receiverId: 't.loud.testnet',
    actions: [{ type: 'FunctionCall', params: { methodName: 'buy', args: { min_tokens_out: '1' }, gas: '100000000000000', deposit: '2000000000000000000000000' } }],
  }]);
});

test('a wallet outcome is read back by hash and parsed like a test wallet call (recorded buy)', async () => {
  // The wallet's own outcome object is not trusted: only its hash is used.
  const s = setup(() => ({ transaction: { hash: BUY.transaction.hash }, status: { Failure: 'ignored' } }));
  const r = await send(s);
  const direct = C.summarizeResult(BUY, BUY.transaction.hash);
  assert.equal(r.outcome, 'success');
  assert.equal(r.ok, true);
  assert.deepEqual(r.events, direct.events);
  assert.equal(r.settlement, 'settled');
  assert.equal(r.via, 'wallet');
  assert.deepEqual(r.signedHashes, [BUY.transaction.hash]);
  assert.equal(r.explorerUrl, C.txUrl(BUY.transaction.hash));
  assert.deepEqual(s.looked, [[BUY.transaction.hash, SENDER]]);
  const line = TL.describeResult('buy', { accountId: SENDER, call: 'buy with 2 NEAR', deposit: 2n * 10n ** 24n }, r);
  assert.match(line.message, /^Bought [\d,]+ LOUD with 2\.0000 NEAR/);
});

test('a failed call (recorded sell) keeps the contract error code', async () => {
  const s = setup(() => ({ transaction_outcome: { id: SELL.transaction.hash } }));
  const r = await send(s);
  assert.equal(r.outcome, 'failure');
  assert.equal(r.errorCode, 'E_NO_QUIET');
  assert.equal(r.hash, SELL.transaction.hash);
});

test('a bare hash or a one-item array from the wallet is enough', async () => {
  for (const answer of [BUY.transaction.hash, [{ transaction: { hash: BUY.transaction.hash } }]]) {
    const r = await send(setup(() => answer));
    assert.equal(r.outcome, 'success');
  }
});

test('a rejection in the wallet says nothing was sent', async () => {
  const s = setup(() => {
    throw new Error('User rejected the request');
  });
  const r = await send(s);
  assert.equal(r.outcome, 'invalid');
  assert.equal(r.rejected, true);
  assert.match(r.errorMessage, /Nothing was signed or sent/);
  assert.equal(s.looked.length, 0);
  const line = TL.describeResult('buy', { accountId: SENDER, call: 'buy' }, r);
  assert.match(line.call, /rejected in the wallet/);
});

test('any other wallet error, an empty answer or a lookup that fails is unknown, never "nothing sent"', async () => {
  const cases = [
    setup(() => {
      throw new Error('Wallet connection lost');
    }),
    setup(() => undefined),
    setup(() => ({ status: { SuccessValue: '' } })),
    setup(() => ({ transaction: { hash: BUY.transaction.hash } }), { lookup: false }),
  ];
  for (const s of cases) {
    const r = await send(s);
    assert.equal(r.outcome, 'unknown');
    assert.equal(r.ok, false);
    assert.equal(r.rejected, undefined);
    assert.doesNotMatch(r.errorMessage, /[Nn]othing was (signed or )?sent/);
    const line = TL.describeResult('buy', { accountId: SENDER, call: 'buy' }, r);
    assert.equal(line.unknown, true);
    assert.match(line.hint, /second transaction/);
  }
  // The lookup failure keeps the hash and its link.
  const r = await send(cases[3]);
  assert.equal(r.hash, BUY.transaction.hash);
  assert.equal(r.explorerUrl, C.txUrl(BUY.transaction.hash));
});

test('an error that carries a hash is looked up', async () => {
  const s = setup(() => {
    const e = new Error('Transaction failed');
    e.context = { transactionHash: SELL.transaction.hash };
    throw e;
  });
  const r = await send(s);
  assert.equal(r.outcome, 'failure');
  assert.equal(r.errorCode, 'E_NO_QUIET');
});

test('a wallet that never answers ends as unknown when the visitor stops waiting or time runs out', async () => {
  const s = setup(() => new Promise(() => {}));
  let stop;
  const stopped = new Promise((r) => {
    stop = r;
  });
  const pending = send(s, { stop: stopped });
  stop();
  const r = await pending;
  assert.equal(r.outcome, 'unknown');
  assert.match(r.errorMessage, /stopped waiting/);
  const r2 = await send(setup(() => new Promise(() => {})), { waitMs: 20 });
  assert.equal(r2.outcome, 'unknown');
  assert.match(r2.errorMessage, /did not answer/);
});

test('a test wallet still goes through chain.call', async () => {
  const calls = [];
  const chain = { call: async (...a) => (calls.push(a), { outcome: 'success' }) };
  const w = { accountId: 'a.testnet', publicKey: 'p', secretKey: 's' };
  const r = await W.callWith(chain, w, 't', 'shout', { amount: '1' }, { depositYocto: '1' });
  assert.equal(r.outcome, 'success');
  assert.deepEqual(calls, [[w, 't', 'shout', { amount: '1' }, { depositYocto: '1' }]]);
});

test('connected accounts are checked: testnet ids only, and the account must exist there', async () => {
  const wallet = (id) => ({ manifest: { id: 'x', name: 'X' }, getAccounts: async () => [{ accountId: id }] });
  const chain = (exists, fail = false) => ({ accountState: async () => {
    if (fail) throw new Error('fetch failed');
    return { exists };
  } });
  const ok = await W.connectedAccount(wallet('bob.testnet'), chain(true));
  assert.deepEqual([ok.kind, ok.accountId, ok.walletName], ['connected', 'bob.testnet', 'X']);
  await assert.rejects(W.connectedAccount(wallet('bob.near'), chain(true)), /not a NEAR testnet account/);
  await assert.rejects(W.connectedAccount(wallet('bob.testnet'), chain(false)), /does not exist on NEAR testnet/);
  // A read error is "could not check", not "wrong network".
  await assert.rejects(W.connectedAccount(wallet('bob.testnet'), chain(true, true)), /Could not check bob\.testnet/);
  assert.equal(W.isTestnetAccountId('a'.repeat(64)), true);
  assert.equal(W.isTestnetAccountId('Bob.testnet'), false);
  assert.match(W.connectFailure(new Error('User rejected')), /closed/);
});

test('the connector runs only when its download matches the pinned SHA-384', async () => {
  const good = new TextEncoder().encode('export class NearConnector {}');
  const pinned = createHash('sha384').update(good).digest('base64');
  let imported = 0;
  const opts = (bytes) => ({
    fetchImpl: async (url, init) => {
      assert.equal(url, W.CONNECTOR.url);
      assert.equal(init.credentials, 'omit');
      return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(0) };
    },
    importer: async () => {
      imported += 1;
      return { NearConnector: class {} };
    },
    makeUrl: () => 'blob:x',
    revoke: () => {},
  });
  // The real pin does not match these bytes: nothing is imported.
  await assert.rejects(W.loadConnector(opts(good)), /does not match its pinned checksum/);
  assert.equal(imported, 0);
  assert.equal(await W.sha384Base64(good), pinned);
  assert.match(W.CONNECTOR.url, /@[0-9a-f]{40}\/cdn\/hot-connect\.es\.js$/);
  assert.match(W.CONNECTOR.url, new RegExp(W.CONNECTOR.commit));
  await assert.rejects(W.loadConnector({ ...opts(good), fetchImpl: async () => ({ ok: false, status: 404 }) }), /HTTP 404/);
});

test('the mock connector drives a connected wallet through the mock chain', async () => {
  const mock = TL.createMockChain();
  const lib = W.createFakeConnectorModule(mock);
  const connector = new lib.NearConnector(W.CONNECTOR_OPTIONS);
  const wallet = await connector.connect();
  const conn = await W.connectedAccount(wallet, mock);
  const r = await W.callWith(mock, conn, TL.MOCK_TOKEN, 'buy', { min_tokens_out: '1' }, { depositYocto: (2n * 10n ** 24n).toString() });
  assert.equal(r.outcome, 'success');
  assert.equal(r.explorerUrl, null);
  assert.ok(r.events.some((e) => e.event === 'buy'));
  lib.control.next = 'reject';
  const no = await W.callWith(mock, conn, TL.MOCK_TOKEN, 'sell', { amount: '1' }, { depositYocto: '1' });
  assert.equal(no.rejected, true);
  const fail = await W.callWith(mock, conn, TL.MOCK_TOKEN, 'sell', { amount: '1', min_near_out: '0' }, { depositYocto: '1' });
  assert.equal(fail.outcome, 'failure');
  assert.equal(fail.errorCode, 'E_NO_QUIET');
  lib.control.connect = 'mainnet';
  await assert.rejects(W.connectedAccount(await connector.connect(), mock), /not a NEAR testnet account/);
});

test('the page keeps the connection flag under the same storage key', () => {
  const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  assert.ok(app.includes(`const WC_KEY = '${W.CONNECTED_KEY}';`));
  // The connector module is never imported statically by the page.
  assert.doesNotMatch(app, /^import .*wallet-connect/m);
});
