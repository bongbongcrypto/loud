import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from './chain.js';

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s) => Uint8Array.from(s.match(/../g).map((h) => parseInt(h, 16)));
const utf8 = (s) => hex(new TextEncoder().encode(s));

// A fixed key: the seed is the bytes 1..32. Its public key is derived here through
// WebCrypto's JWK export, independently of chain.js.
const SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const PKCS8 = unhex('302e020100300506032b657004220420' + hex(SEED));
async function fixedWallet() {
  const priv = await crypto.subtle.importKey('pkcs8', PKCS8, { name: 'Ed25519' }, true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', priv);
  const pub = Uint8Array.from(Buffer.from(jwk.x, 'base64url'));
  const secretKey = `ed25519:${C.base58Encode(Uint8Array.from([...SEED, ...pub]))}`;
  return { pub, wallet: { accountId: 'alice.testnet', publicKey: `ed25519:${C.base58Encode(pub)}`, secretKey } };
}

test('base58 round trip, with leading zeros', () => {
  for (const bytes of [[0], [0, 0, 1], [255, 254, 0, 3], Array.from({ length: 32 }, (_, i) => (i * 7) % 256)]) {
    const text = C.base58Encode(bytes);
    assert.deepEqual([...C.base58Decode(text)], bytes);
  }
  assert.equal(C.base58Encode([0, 0, 1]), '112');
  assert.equal(C.base58Encode(new TextEncoder().encode('hello world')), 'StV1DL6CwTryKyV');
  assert.throws(() => C.base58Decode('0OIl'), /not base58/);
});

test('base64 round trip', () => {
  const bytes = Uint8Array.from({ length: 70000 }, (_, i) => i % 251);
  assert.deepEqual(C.base64Decode(C.base64Encode(bytes)), bytes);
  assert.equal(C.base64Encode(new TextEncoder().encode('{"a":1}')), 'eyJhIjoxfQ==');
});

test('a transaction is laid out as NEAR nodes read it', async () => {
  const { pub, wallet } = await fixedWallet();
  const blockHash = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
  const args = { amount: '5', min_near_out: '0' };
  const bytes = C.encodeTransaction({
    signerId: 'alice.testnet', publicKey: wallet.publicKey, nonce: 0x0102030405n, receiverId: 't.loud.testnet',
    blockHash: C.base58Encode(blockHash), method: 'sell', args, gas: 80n * C.TGAS, deposit: 1n,
  });
  const expected = [
    '0d000000', utf8('alice.testnet'), // signer_id
    '00', hex(pub), // ed25519 public key
    '0504030201000000', // nonce, u64 little endian
    '0e000000', utf8('t.loud.testnet'), // receiver_id
    hex(blockHash),
    '01000000', // one action
    '02', // FunctionCall
    '04000000', utf8('sell'),
    '21000000', utf8(JSON.stringify(args)),
    '00009573c2480000', // 80 Tgas = 80_000_000_000_000 = 0x48c273950000, u64 little endian
    '01000000000000000000000000000000', // deposit, u128 little endian
  ].join('');
  assert.equal(hex(bytes), expected);
  assert.equal(JSON.stringify(args).length, 0x21);
  assert.equal(80n * C.TGAS, 0x48c273950000n);
  // The largest values still fit.
  const big = C.encodeTransaction({
    signerId: 'a.testnet', publicKey: wallet.publicKey, nonce: 2n ** 64n - 1n, receiverId: 'b.testnet',
    blockHash, method: 'buy', args: new Uint8Array(0), gas: 300n * C.TGAS, deposit: 2n ** 128n - 1n,
  });
  assert.equal(hex(big.slice(big.length - 16)), 'ff'.repeat(16));
  assert.throws(() => C.encodeTransaction({
    signerId: 'a.testnet', publicKey: wallet.publicKey, nonce: 1n, receiverId: 'b.testnet', blockHash, method: 'x', gas: 2n ** 64n,
  }), /does not fit/);
  assert.throws(() => C.encodeTransaction({
    signerId: 'a.testnet', publicKey: wallet.publicKey, nonce: 1n, receiverId: 'b.testnet', blockHash: [1, 2, 3], method: 'x', gas: 1n,
  }), /32 bytes/);
});

test('the signature is ed25519 over sha256 of the transaction, and the hash is that digest', async () => {
  const { pub, wallet } = await fixedWallet();
  const txBytes = C.encodeTransaction({
    signerId: wallet.accountId, publicKey: wallet.publicKey, nonce: 7n, receiverId: 't.loud.testnet',
    blockHash: new Uint8Array(32).fill(9), method: 'shout', args: { amount: '1000' }, gas: 30n * C.TGAS, deposit: 1n,
  });
  const signed = await C.signTransaction(wallet.secretKey, txBytes);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', txBytes));
  assert.equal(signed.hash, C.base58Encode(digest));
  assert.equal(signed.signedBytes.length, txBytes.length + 1 + 64);
  assert.deepEqual(signed.signedBytes.slice(0, txBytes.length), txBytes);
  assert.equal(signed.signedBytes[txBytes.length], 0);
  const signature = signed.signedBytes.slice(txBytes.length + 1);
  const verifyKey = await crypto.subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify']);
  assert.equal(await crypto.subtle.verify({ name: 'Ed25519' }, verifyKey, signature, digest), true);
  assert.equal(await crypto.subtle.verify({ name: 'Ed25519' }, verifyKey, signature, txBytes), false);
  // Ed25519 is deterministic: the same key and bytes give the same signature.
  assert.equal(hex((await C.signTransaction(wallet.secretKey, txBytes)).signedBytes), hex(signed.signedBytes));
  assert.deepEqual(C.base64Decode(signed.signedBase64), signed.signedBytes);
});

test('a generated key pair signs, and its strings have the near form', async () => {
  const keys = await C.generateKeyPair();
  assert.match(keys.publicKey, /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  const secret = C.base58Decode(keys.secretKey.split(':')[1]);
  assert.equal(secret.length, 64);
  assert.deepEqual(secret.slice(32), C.publicKeyBytes(keys.publicKey));
  const msg = new Uint8Array(32).fill(3);
  const signature = await C.signBytes(keys.secretKey, msg);
  const verifyKey = await crypto.subtle.importKey('raw', C.publicKeyBytes(keys.publicKey), { name: 'Ed25519' }, false, ['verify']);
  assert.equal(await crypto.subtle.verify({ name: 'Ed25519' }, verifyKey, signature, msg), true);
  const other = await C.generateKeyPair();
  assert.notEqual(other.secretKey, keys.secretKey);
});

test('wallets go through JSON unchanged, and a wrong pair is refused', async () => {
  const { wallet } = await fixedWallet();
  const back = C.importWallet(JSON.parse(JSON.stringify(C.exportWallet({ ...wallet, extra: 1 }))));
  assert.deepEqual(back, wallet);
  const other = await C.generateKeyPair();
  assert.throws(() => C.importWallet({ ...wallet, publicKey: other.publicKey }), /does not belong/);
  assert.throws(() => C.importWallet({ ...wallet, accountId: 'Not An Id' }), /account id/);
  assert.throws(() => C.importWallet(null), /not a wallet/);
});

test('contract panics become error codes', () => {
  const failure = { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: E_NO_QUIET: sell uses quiet tokens only; you hold 5 loud' } } } };
  assert.equal(C.failureText(failure), 'E_NO_QUIET: sell uses quiet tokens only; you hold 5 loud');
  assert.equal(C.errorCode(C.failureText(failure)), 'E_NO_QUIET');
  assert.equal(C.errorCode('E_NOTICE_BINDING: a shout cannot be taken back'), 'E_NOTICE_BINDING');
  assert.equal(C.errorCode('no code here'), null);
  assert.equal(C.failureText(undefined), null);
});

const b64json = (v) => Buffer.from(JSON.stringify(v)).toString('base64');
const okReceipt = (logs = []) => ({ id: 'r', outcome: { executor_id: 't.testnet', logs, status: { SuccessValue: '' } } });

test('a result is summarized with value, logs, events and settlement', () => {
  const event = 'EVENT_JSON:{"standard":"loud","version":"1.0.0","event":"leave","data":[{"id":"3","filled":"12"}]}';
  const good = C.summarizeResult({
    status: { SuccessValue: b64json('12') },
    transaction: { hash: 'HASH1' },
    receipts_outcome: [okReceipt([event, 'plain line']), okReceipt()],
  }, 'local');
  assert.equal(good.ok, true);
  assert.equal(good.outcome, 'success');
  assert.equal(good.hash, 'HASH1');
  assert.equal(good.value, '12');
  assert.equal(good.errorCode, null);
  assert.equal(good.settled, true);
  assert.deepEqual(good.events, [{ standard: 'loud', event: 'leave', data: { id: '3', filled: '12' } }]);
  assert.equal(good.explorerUrl, 'https://testnet.nearblocks.io/txns/HASH1');

  const panic = C.summarizeResult({
    status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: E_CAP: the global cap has no room right now' } } } } },
    receipts_outcome: [{ id: 'r', outcome: { executor_id: 't.testnet', logs: [], status: { Failure: {} } } }],
  }, 'HASH2');
  assert.equal(panic.ok, false);
  assert.equal(panic.outcome, 'failure');
  assert.equal(panic.errorCode, 'E_CAP');
  assert.equal(panic.hash, 'HASH2');
  assert.equal(panic.settled, false);
  assert.equal(panic.value, null);

  // The call succeeded but its payout did not arrive.
  const unpaid = 'EVENT_JSON:{"standard":"loud","version":"1.0.0","event":"payout_failed","data":[{"account":"a.testnet","amount":"5"}]}';
  const owed = C.summarizeResult({ status: { SuccessValue: b64json('1') }, receipts_outcome: [okReceipt(), okReceipt([unpaid])] }, 'H');
  assert.equal(owed.ok, true);
  assert.equal(owed.settled, false);
  // An empty success value is a null value.
  assert.equal(C.summarizeResult({ status: { SuccessValue: '' }, receipts_outcome: [okReceipt()] }, 'H').value, null);
});

// A scripted RPC: every request is answered from `answers` by method name.
function fakeRpc(answers) {
  const seen = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ url, method: body.method, params: body.params });
    const answer = answers(body, url);
    if (answer instanceof Error) throw answer;
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, ...answer }) };
  };
  return { fetch, seen };
}

test('view sends base64 JSON arguments and parses the byte result; endpoints fail over', async () => {
  const { fetch, seen } = fakeRpc((body, url) => {
    if (url === 'https://one.example') return new Error('down');
    return { result: { result: [...new TextEncoder().encode('{"loud":"7"}')], logs: [] } };
  });
  C.configure({ rpcUrls: ['https://one.example', 'https://two.example'], fetch });
  const got = await C.view('t.testnet', 'get_account', { account_id: 'a.testnet' });
  assert.deepEqual(got, { loud: '7' });
  assert.deepEqual(seen.map((s) => s.url), ['https://one.example', 'https://two.example']);
  assert.equal(seen[1].params.request_type, 'call_function');
  assert.equal(seen[1].params.finality, 'final');
  assert.deepEqual(JSON.parse(Buffer.from(seen[1].params.args_base64, 'base64').toString()), { account_id: 'a.testnet' });
});

test('accountState tells a missing account from an existing one', async () => {
  const { fetch } = fakeRpc((body) => (body.params.account_id === 'gone.testnet'
    ? { error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT' } } }
    : { result: { amount: '123', code_hash: '1'.repeat(32) } }));
  C.configure({ rpcUrls: ['https://one.example'], fetch });
  assert.deepEqual(await C.accountState('gone.testnet'), { exists: false, amountYocto: '0' });
  assert.deepEqual(await C.accountState('here.testnet'), { exists: true, amountYocto: '123' });
});

test('call signs with the next nonce, sends, and reports a contract panic without throwing', async () => {
  const { wallet } = await fixedWallet();
  const blockHash = C.base58Encode(new Uint8Array(32).fill(5));
  let sent = null;
  const { fetch, seen } = fakeRpc((body) => {
    if (body.method === 'query') return { result: { nonce: 41, permission: 'FullAccess' } };
    if (body.method === 'block') return { result: { header: { hash: blockHash } } };
    if (body.method === 'send_tx') {
      sent = body.params;
      return { result: {
        status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: E_NOTICE: the notice period ends in 57 s' } } } } },
        receipts_outcome: [],
      } };
    }
    return new Error(`unexpected ${body.method}`);
  });
  C.configure({ rpcUrls: ['https://one.example'], fetch });
  const w = { ...wallet, accountId: 'nonce-test.testnet' };
  const r = await C.call(w, 't.testnet', 'leave', { exit_id: '1', min_near_out: '0' }, { gasTgas: 80, depositYocto: '1' });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'failure');
  assert.equal(r.errorCode, 'E_NOTICE');
  assert.match(r.hash, /^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  assert.equal(sent.wait_until, 'FINAL');
  const expectedTx = C.encodeTransaction({
    signerId: w.accountId, publicKey: w.publicKey, nonce: 42n, receiverId: 't.testnet', blockHash,
    method: 'leave', args: { exit_id: '1', min_near_out: '0' }, gas: 80n * C.TGAS, deposit: 1n,
  });
  const signedBytes = C.base64Decode(sent.signed_tx_base64);
  assert.deepEqual(signedBytes.slice(0, expectedTx.length), expectedTx);
  // The second call does not ask for the key again and uses nonce 43.
  await C.call(w, 't.testnet', 'leave', { exit_id: '1', min_near_out: '0' }, { gasTgas: 80, depositYocto: '1' });
  assert.equal(seen.filter((s) => s.method === 'query').length, 1);
  const second = C.base64Decode(sent.signed_tx_base64);
  const nonceAt = 4 + w.accountId.length + 1 + 32;
  assert.equal(second[nonceAt], 43);
});

test('a transaction a node refuses is reported as invalid; a stale nonce is retried once', async () => {
  const { wallet } = await fixedWallet();
  const blockHash = C.base58Encode(new Uint8Array(32).fill(6));
  let sends = 0;
  const { fetch } = fakeRpc((body) => {
    if (body.method === 'query') return { result: { nonce: 10 + sends, permission: 'FullAccess' } };
    if (body.method === 'block') return { result: { header: { hash: blockHash } } };
    if (body.method === 'send_tx') {
      sends += 1;
      if (sends === 1) return { error: { name: 'HANDLER_ERROR', cause: { name: 'INVALID_TRANSACTION' }, data: { TxExecutionError: { InvalidTxError: { InvalidNonce: { tx_nonce: 11, ak_nonce: 11 } } } } } };
      return { error: { name: 'HANDLER_ERROR', cause: { name: 'INVALID_TRANSACTION' }, data: { TxExecutionError: { InvalidTxError: { NotEnoughBalance: { signer_id: 'x' } } } } } };
    }
    return new Error(`unexpected ${body.method}`);
  });
  C.configure({ rpcUrls: ['https://one.example'], fetch });
  const r = await C.call({ ...wallet, accountId: 'refused.testnet' }, 't.testnet', 'buy', { min_tokens_out: '1' }, { depositYocto: '5' });
  assert.equal(sends, 2);
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'invalid');
  assert.match(r.errorMessage, /NotEnoughBalance/);
  assert.equal(r.errorCode, null);
  // Nothing is on chain, so there is no hash to link; the refused one is kept apart.
  assert.equal(r.hash, null);
  assert.equal(r.explorerUrl, null);
  assert.match(r.refusedHash, /^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
});

test('a wallet whose key is not on chain gets a result, not an exception', async () => {
  const { wallet } = await fixedWallet();
  let sends = 0;
  const { fetch } = fakeRpc((body) => {
    if (body.method === 'query') return { error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT' } } };
    sends += 1;
    return new Error(`unexpected ${body.method}`);
  });
  C.configure({ rpcUrls: ['https://one.example'], fetch });
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, _ms, ...a) => realSetTimeout(fn, 0, ...a); // skip the waits between lookups
  try {
    const r = await C.call({ ...wallet, accountId: 'never-made.testnet' }, 't.testnet', 'buy', {}, {});
    assert.deepEqual([r.ok, r.outcome, r.hash, r.errorCode], [false, 'invalid', null, null]);
    assert.match(r.errorMessage, /not on chain/);
    assert.equal(sends, 0);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test('createTestWallet asks the faucet and waits for the key to show on chain', async () => {
  let asked = null;
  let keyQueries = 0;
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (url === 'https://faucet.example/account') {
      asked = body;
      return { ok: true, status: 200, text: async () => '{}' };
    }
    keyQueries += 1;
    if (keyQueries < 2) return { ok: true, status: 200, json: async () => ({ id: body.id, error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCESS_KEY' } } }) };
    return { ok: true, status: 200, json: async () => ({ id: body.id, result: { nonce: 0 } }) };
  };
  C.configure({ rpcUrls: ['https://one.example'], faucetUrls: ['https://faucet.example/account'], fetch });
  const w = await C.createTestWallet({ prefix: 'unit' });
  assert.match(w.accountId, /^unit-[a-z0-9]+\.testnet$/);
  assert.equal(asked.newAccountId, w.accountId);
  assert.equal(asked.newAccountPublicKey, w.publicKey);
  assert.deepEqual(C.importWallet(w), w);
  assert.equal(keyQueries, 2);
});

test('links', () => {
  assert.equal(C.txUrl('abc'), 'https://testnet.nearblocks.io/txns/abc');
  assert.equal(C.accountUrl('a.testnet'), 'https://testnet.nearblocks.io/address/a.testnet');
  assert.equal(C.NETWORK, 'testnet');
  assert.equal(C.RPC_URLS[0], 'https://test.rpc.fastnear.com');
});
