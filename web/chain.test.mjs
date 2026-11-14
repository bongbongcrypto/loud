import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

test('CreateAccount, Transfer and AddKey are laid out as NEAR nodes read them', async () => {
  const { pub, wallet } = await fixedWallet();
  const other = await C.generateKeyPair();
  const blockHash = Uint8Array.from({ length: 32 }, (_, i) => i);
  const bytes = C.encodeTransaction({
    signerId: 'alice.testnet', publicKey: wallet.publicKey, nonce: 5n, receiverId: 'b0a1b2c3d.alice.testnet', blockHash,
    actions: [C.createAccount(), C.transfer(3n * C.YOCTO), C.addFullAccessKey(other.publicKey)],
  });
  const expected = [
    '0d000000', utf8('alice.testnet'),
    '00', hex(pub),
    '0500000000000000',
    '17000000', utf8('b0a1b2c3d.alice.testnet'),
    hex(blockHash),
    '03000000', // three actions
    '00', // CreateAccount
    '03', '000000e3c8666c53467b020000000000', // Transfer 3 NEAR = 3 * 10^24 yocto, u128 little endian
    '05', '00', hex(C.publicKeyBytes(other.publicKey)), '0000000000000000', '01', // AddKey: ed25519 key, nonce 0, FullAccess
  ].join('');
  assert.equal(hex(bytes), expected);
  // One FunctionCall in the list form is the same bytes as the single-call form.
  const one = { signerId: 'a.testnet', publicKey: wallet.publicKey, nonce: 9n, receiverId: 't.testnet', blockHash };
  assert.equal(
    hex(C.encodeTransaction({ ...one, actions: [C.functionCall('buy', { min_tokens_out: '1' }, 50n * C.TGAS, 7n)] })),
    hex(C.encodeTransaction({ ...one, method: 'buy', args: { min_tokens_out: '1' }, gas: 50n * C.TGAS, deposit: 7n })),
  );
  assert.throws(() => C.encodeTransaction({ ...one, actions: [] }), /at least one action/);
  assert.throws(() => C.encodeAction({ type: 'Stake' }), /not supported/);
});

test('a keyless launch (CreateAccount, Transfer, DeployContract, FunctionCall) is laid out as NEAR nodes read it', async () => {
  const { pub, wallet } = await fixedWallet();
  const blockHash = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
  const code = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0); // "\0asm" version 1
  const bytes = C.encodeTransaction({
    signerId: 'alice.testnet', publicKey: wallet.publicKey, nonce: 7n, receiverId: 't1.alice.testnet', blockHash,
    actions: [C.createAccount(), C.transfer(5n * C.YOCTO), C.deployContract(code), C.functionCall('new', { a: 1 }, 200n * C.TGAS, 0n)],
  });
  const expected = [
    '0d000000', utf8('alice.testnet'),
    '00', hex(pub),
    '0700000000000000',
    '10000000', utf8('t1.alice.testnet'),
    hex(blockHash),
    '04000000', // four actions
    '00', // CreateAccount
    '03', '00000025a4000a8bca22040000000000', // Transfer 5 NEAR, u128 little endian
    '01', '08000000', '0061736d01000000', // DeployContract: u32 length, then the code
    '02', '03000000', utf8('new'), '07000000', utf8('{"a":1}'), '0080f420e6b50000', '00000000000000000000000000000000', // FunctionCall new, 200 Tgas, 0 deposit
  ].join('');
  assert.equal(hex(bytes), expected);
  assert.throws(() => C.encodeAction(C.deployContract(new Uint8Array(0))), /non-empty Uint8Array/);
  assert.throws(() => C.encodeAction(C.deployContract('not bytes')), /non-empty Uint8Array/);
});

test('a launch with a contract-sized code (256 KiB) signs, and its base64 decodes to the same bytes', async () => {
  const { wallet } = await fixedWallet();
  const code = new Uint8Array(256 * 1024).map((_, i) => (i * 131 + 17) & 0xff);
  const txBytes = C.encodeTransaction({
    signerId: 'alice.testnet', publicKey: wallet.publicKey, nonce: 1n, receiverId: 't1.alice.testnet', blockHash: new Uint8Array(32).fill(9),
    actions: [C.createAccount(), C.transfer(5n * C.YOCTO), C.deployContract(code), C.functionCall('new', {}, 200n * C.TGAS, 0n)],
  });
  const signed = await C.signTransaction(wallet.secretKey, txBytes);
  assert.equal(hex(C.base64Decode(signed.signedBase64)), hex(signed.signedBytes));
  assert.equal(signed.signedBytes.length, txBytes.length + 65);
  assert.equal(signed.hash, C.base58Encode(createHash('sha256').update(txBytes).digest()));
});

test('sendActions sends a launch in one transaction under the same rules as call', async () => {
  const net = fakeNet({});
  C.configure({ rpcUrls: URLS, fetch: net.fetch, confirmMs: 60_000 });
  const code = new Uint8Array(4096).map((_, i) => i & 0xff);
  const actions = [C.createAccount(), C.transfer(5n * C.YOCTO), C.deployContract(code), C.functionCall('new', {}, 200n * C.TGAS, 0n)];
  const r = await withoutWaits(async () => C.sendActions(await twice(), 't1.twice.testnet', actions, { confirmMs: 30_000 }));
  assert.equal(r.outcome, 'success');
  assert.deepEqual(net.nonces, [42n]);
  assert.equal(r.signedHashes.length, 1);
  const sent = C.base64Decode(net.sendBodies[0].b64);
  assert.ok(hex(sent).includes(`0100100000${hex(code)}`), 'the code is in the signed bytes after tag 1 and its u32 length');
});

test('the public key is derived from a private key in either near-cli form', async () => {
  const { wallet } = await fixedWallet();
  assert.equal(await C.publicKeyFromSecret(wallet.secretKey), wallet.publicKey);
  const seedOnly = `ed25519:${C.base58Encode(SEED)}`;
  assert.equal(await C.publicKeyFromSecret(seedOnly), wallet.publicKey);
  const other = await C.generateKeyPair();
  const mixed = `ed25519:${C.base58Encode([...SEED, ...C.publicKeyBytes(other.publicKey)])}`;
  await assert.rejects(C.publicKeyFromSecret(mixed), /not a valid ed25519 key pair/);
});

// A small simulated testnet: nodes that share one access key nonce and remember what they
// executed. `hook(url, body, net, execute)` may answer a request first (undefined: go on).
const sha = (bytes) => new Uint8Array(createHash('sha256').update(bytes).digest());
function fakeNet({ akNonce = 41, signer = 'twice.testnet', hook = () => undefined } = {}) {
  const net = { nonce: akNonce, executed: new Map(), sendBodies: [], txLookups: 0, nonces: [] };
  const execute = (b64) => {
    const signed = C.base64Decode(b64);
    const txBytes = signed.slice(0, signed.length - 65);
    const hash = C.base58Encode(sha(txBytes));
    const at = 4 + signer.length + 1 + 32;
    let n = 0n;
    for (let i = 7; i >= 0; i--) n = n * 256n + BigInt(txBytes[at + i]);
    if (n <= BigInt(net.nonce)) {
      return { hash, error: { name: 'HANDLER_ERROR', cause: { name: 'INVALID_TRANSACTION' }, data: { TxExecutionError: { InvalidTxError: { InvalidNonce: { tx_nonce: Number(n), ak_nonce: net.nonce } } } } } };
    }
    net.nonce = Number(n);
    net.nonces.push(n);
    const result = { status: { SuccessValue: b64json(String(n)) }, transaction: { hash }, receipts_outcome: [okReceipt()] };
    net.executed.set(hash, result);
    return { hash, result };
  };
  net.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const reply = (x) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, ...x }) });
    if (body.method === 'send_tx' || body.method === 'broadcast_tx_async') {
      net.sendBodies.push({ url, method: body.method, b64: body.method === 'send_tx' ? body.params.signed_tx_base64 : body.params[0] });
    }
    if (body.method === 'tx') net.txLookups += 1;
    const hooked = await hook(url, body, net, execute);
    if (hooked instanceof Error) throw hooked;
    if (hooked !== undefined) return reply(hooked);
    if (body.method === 'query') return reply({ result: { nonce: net.nonce, permission: 'FullAccess' } });
    if (body.method === 'block') return reply({ result: { header: { hash: C.base58Encode(new Uint8Array(32).fill(8)) } } });
    if (body.method === 'send_tx') {
      const r = execute(body.params.signed_tx_base64);
      return reply(r.error ? { error: r.error } : { result: r.result });
    }
    if (body.method === 'broadcast_tx_async') {
      const r = execute(body.params[0]);
      return reply(r.error ? { error: r.error } : { result: r.hash });
    }
    if (body.method === 'tx') {
      const r = net.executed.get(body.params.tx_hash);
      return reply(r ? { result: r } : { error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_TRANSACTION' } } });
    }
    throw new Error(`unexpected ${body.method}`);
  };
  return net;
}

async function withoutWaits(fn) {
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (f, _ms, ...a) => realSetTimeout(f, 0, ...a);
  try {
    return await fn();
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
}

const twice = async () => ({ ...(await fixedWallet()).wallet, accountId: 'twice.testnet' });
const URLS = ['https://one.example', 'https://two.example', 'https://three.example'];

test('a send whose answer is lost after the node executed it is looked up by hash, not signed again', async () => {
  // The first node executes the transaction and the connection drops before the answer.
  const net = fakeNet({
    hook: (url, body, n, execute) => {
      if (url === URLS[0] && body.method === 'send_tx') {
        execute(body.params.signed_tx_base64);
        return new Error('socket hang up');
      }
      return undefined;
    },
  });
  C.configure({ rpcUrls: URLS, fetch: net.fetch, confirmMs: 60_000 });
  const r = await withoutWaits(async () => C.call(await twice(), 't.testnet', 'leave', { exit_id: '1', min_near_out: '0' }, { depositYocto: '1' }));
  assert.equal(r.outcome, 'success');
  assert.equal(r.ok, true);
  assert.deepEqual(net.nonces, [42n], 'exactly one nonce executed');
  assert.equal(net.sendBodies.length, 1, 'found by hash before any second broadcast');
  assert.ok(net.txLookups >= 1);
  assert.deepEqual(r.signedHashes, [r.hash]);
  assert.equal(r.value, '42');
});

test('InvalidNonce after a send that may have landed means "look it up", and only the same bytes go out again', async () => {
  // The first node executes and its answer is lost; the next lookups
  // do not see the hash yet; the next node then refuses the same bytes with InvalidNonce,
  // because they already executed. The earlier client signed the action again here.
  let hidden = 3; // lookups that do not see it yet: one per endpoint
  const net = fakeNet({
    hook: (url, body, n, execute) => {
      if (url === URLS[0] && body.method === 'send_tx') {
        execute(body.params.signed_tx_base64);
        return new Error('fetch failed');
      }
      if (body.method === 'tx' && hidden > 0) {
        hidden -= 1;
        return { error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_TRANSACTION' } } };
      }
      return undefined;
    },
  });
  C.configure({ rpcUrls: URLS, fetch: net.fetch, confirmMs: 60_000 });
  const r = await withoutWaits(async () => C.call(await twice(), 't.testnet', 'leave', { exit_id: '1', min_near_out: '0' }, { depositYocto: '1' }));
  assert.equal(r.outcome, 'success');
  assert.deepEqual(net.nonces, [42n], 'one nonce: the action executed once');
  assert.equal(net.sendBodies.length, 2, 'the same transaction was offered to the next node');
  assert.equal(new Set(net.sendBodies.map((s) => s.b64)).size, 1, 'every broadcast carried the same signed bytes');
  assert.deepEqual(r.signedHashes, [r.hash]);
  assert.equal(r.value, '42', "the result is the first transaction's");
});

test('a broadcast transaction without a final outcome in time is "unknown" with its hash, never an exception', async () => {
  const net = fakeNet({
    hook: (url, body) => {
      if (body.method === 'send_tx' || body.method === 'broadcast_tx_async') return new Error('fetch failed');
      if (body.method === 'tx') return { error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_TRANSACTION' } } };
      return undefined;
    },
  });
  C.configure({ rpcUrls: URLS, fetch: net.fetch, confirmMs: 40 });
  const r = await withoutWaits(async () => C.call(await twice(), 't.testnet', 'buy', { min_tokens_out: '1' }, { depositYocto: '5' }));
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'unknown');
  assert.match(r.hash, /^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  assert.equal(r.explorerUrl, `https://testnet.nearblocks.io/txns/${r.hash}`);
  assert.match(r.errorMessage, /was sent, but no node returned its final outcome/);
  assert.equal(new Set(net.sendBodies.map((s) => s.b64)).size, 1);
  assert.deepEqual(r.signedHashes, [r.hash]);
  // A node-side timeout on send_tx means "taken, not final": looked up, never sent again.
  const slow = fakeNet({
    hook: (url, body) => (body.method === 'send_tx' || body.method === 'tx' ? { error: { name: 'HANDLER_ERROR', cause: { name: 'TIMEOUT_ERROR' } } } : undefined),
  });
  C.configure({ rpcUrls: URLS, fetch: slow.fetch, confirmMs: 40 });
  const r2 = await withoutWaits(async () => C.call(await twice(), 't.testnet', 'buy', {}, {}));
  assert.equal(r2.outcome, 'unknown');
  assert.equal(slow.sendBodies.length, 1);
});

test('an error other than a refusal counts as "may have been sent": looked up, not signed again', async () => {
  const net = fakeNet({
    hook: (url, body, n, execute) => {
      if (url === URLS[0] && body.method === 'send_tx') {
        execute(body.params.signed_tx_base64);
        return { error: { name: 'HANDLER_ERROR', cause: { name: 'ROUTING_FAILED' } } };
      }
      return undefined;
    },
  });
  C.configure({ rpcUrls: URLS, fetch: net.fetch, confirmMs: 60_000 });
  const r = await withoutWaits(async () => C.call(await twice(), 't.testnet', 'buy', {}, { depositYocto: '5' }));
  assert.equal(r.outcome, 'success');
  assert.deepEqual(net.nonces, [42n]);
  assert.deepEqual(r.signedHashes, [r.hash]);
});

test('a refusal before any copy could have landed is certain, and a stale nonce gets one new signature', async () => {
  let first = true;
  const net = fakeNet({
    hook: (url, body) => {
      if (body.method === 'send_tx' && first) {
        first = false;
        return { error: { name: 'HANDLER_ERROR', cause: { name: 'INVALID_TRANSACTION' }, data: { TxExecutionError: { InvalidTxError: { InvalidNonce: { tx_nonce: 42, ak_nonce: 42 } } } } } };
      }
      return undefined;
    },
  });
  C.configure({ rpcUrls: URLS, fetch: net.fetch, confirmMs: 60_000 });
  const r = await withoutWaits(async () => C.call(await twice(), 't.testnet', 'shout', { amount: '5' }, { depositYocto: '1' }));
  assert.equal(r.outcome, 'success');
  assert.equal(r.signedHashes.length, 2);
  assert.equal(r.hash, r.signedHashes[1]);
  assert.deepEqual(net.nonces, [42n]);
});

test('createSubWallet makes <random>.<parent> with 3 NEAR and a new full-access key in one transaction', async () => {
  const { wallet } = await fixedWallet();
  const parent = { ...wallet, accountId: 'twice.testnet' };
  let added = null;
  const net = fakeNet({
    hook: (url, body) => {
      if (body.method === 'send_tx') {
        const signed = C.base64Decode(body.params.signed_tx_base64);
        const at = signed.length - 65 - 43; // AddKey: tag, key enum, 32-byte key, u64 nonce, permission
        added = `ed25519:${C.base58Encode(signed.slice(at + 2, at + 34))}`;
      }
      if (body.method === 'query' && body.params.account_id !== 'twice.testnet') {
        return added && body.params.public_key === added
          ? { result: { nonce: 0, permission: 'FullAccess' } }
          : { error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT' } } };
      }
      return undefined;
    },
  });
  C.configure({ rpcUrls: URLS, fetch: net.fetch, confirmMs: 60_000 });
  const b = await withoutWaits(() => C.createSubWallet(parent));
  assert.match(b.accountId, /^b[0-9a-f]{8}\.twice\.testnet$/);
  assert.equal(b.outcome, 'success');
  assert.equal(b.publicKey, added);
  assert.deepEqual(C.importWallet(b), { accountId: b.accountId, publicKey: b.publicKey, secretKey: b.secretKey });
  assert.equal(b.explorerUrl, `https://testnet.nearblocks.io/txns/${b.hash}`);
  // The bytes sent are exactly this transaction.
  const sent = C.base64Decode(net.sendBodies[0].b64);
  const expected = C.encodeTransaction({
    signerId: 'twice.testnet', publicKey: parent.publicKey, nonce: 42n, receiverId: b.accountId,
    blockHash: C.base58Encode(new Uint8Array(32).fill(8)),
    actions: [C.createAccount(), C.transfer(3n * C.YOCTO), C.addFullAccessKey(b.publicKey)],
  });
  assert.equal(hex(sent.slice(0, sent.length - 65)), hex(expected));
  // A parent id too long for a sub-account is refused before anything is signed.
  await assert.rejects(C.createSubWallet({ ...parent, accountId: `${'a'.repeat(50)}.testnet` }), /too long/);
  assert.equal(net.sendBodies.length, 1);
});

test('createSubWallet keeps the new key when the account cannot be read back', async () => {
  const { wallet } = await fixedWallet();
  const parent = { ...wallet, accountId: 'twice.testnet' };
  let sent = false;
  const net = fakeNet({
    hook: (url, body) => {
      if (body.method === 'send_tx') sent = true;
      if (sent && body.method === 'query') return new Error('fetch failed'); // every endpoint down after the send
      return undefined;
    },
  });
  C.configure({ rpcUrls: URLS, fetch: net.fetch, confirmMs: 60_000 });
  const b = await withoutWaits(() => C.createSubWallet(parent));
  assert.equal(b.outcome, 'success');
  assert.match(b.secretKey, /^ed25519:/);
  assert.equal(b.result.ok, true);
});

test('the faucet is asked once: a refusal such as HTTP 429 ends the attempt with its answer', async () => {
  let asked = 0;
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.includes('faucet')) {
      asked += 1;
      return { ok: false, status: 429, text: async () => '{"error":"Too many requests, retry in 12 hours"}' };
    }
    return { ok: true, status: 200, json: async () => ({ id: body.id, error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT' } } }) };
  };
  C.configure({ rpcUrls: URLS, faucetUrls: ['https://faucet.example/account', 'https://faucet2.example/account'], fetch });
  const answers = [];
  const err = await C.createTestWallet({ prefix: 'unit', onAnswer: (a) => answers.push(a) }).catch((e) => e);
  assert.ok(err instanceof C.FaucetError);
  assert.equal(err.status, 429);
  assert.match(err.answer, /retry in 12 hours/);
  assert.match(err.message, /refused to create .*HTTP 429/);
  assert.equal(asked, 1);
  assert.deepEqual(answers.map((a) => [a.host, a.status]), [['faucet.example', 429]]);
});

test('importTestWallet needs a testnet id and a full-access key that is on the account', async () => {
  const { wallet } = await fixedWallet();
  let permission = 'FullAccess';
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const p = body.params;
    const ok = p.account_id === 'mine.testnet' && p.public_key === wallet.publicKey;
    return { ok: true, status: 200, json: async () => (ok
      ? { id: body.id, result: { nonce: 3, permission } }
      : { id: body.id, error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCESS_KEY' } } }) };
  };
  C.configure({ rpcUrls: URLS, fetch });
  const seedOnly = `ed25519:${C.base58Encode(SEED)}`;
  assert.deepEqual(await C.importTestWallet(' mine.testnet ', seedOnly), { accountId: 'mine.testnet', publicKey: wallet.publicKey, secretKey: seedOnly });
  assert.deepEqual(await C.importTestWallet('mine.testnet', wallet.secretKey), { accountId: 'mine.testnet', publicKey: wallet.publicKey, secretKey: wallet.secretKey });
  await assert.rejects(C.importTestWallet('mine.near', wallet.secretKey), /testnet account id/);
  await assert.rejects(C.importTestWallet('other.testnet', wallet.secretKey), /not on other\.testnet/);
  const bad = await C.importTestWallet('mine.testnet', 'ed25519:notakey0OIl').catch((e) => e);
  assert.match(bad.message, /not an ed25519 private key/);
  assert.ok(!bad.message.includes('notakey'));
  permission = { FunctionCall: { allowance: null, receiver_id: 't.testnet', method_names: [] } };
  await assert.rejects(C.importTestWallet('mine.testnet', wallet.secretKey), /full-access key/);
});

test('settlement tells a payout recorded for claim from one that is not confirmed', () => {
  const unpaid = 'EVENT_JSON:{"standard":"loud","version":"1.0.0","event":"payout_failed","data":[{"account":"seller.testnet","amount":"5"}]}';
  const owed = C.summarizeResult({ status: { SuccessValue: b64json('1') }, receipts_outcome: [okReceipt(), okReceipt([unpaid])] }, 'H');
  assert.equal(owed.settlement, 'payout_failed');
  assert.deepEqual(owed.payoutsFailed, [{ account: 'seller.testnet', amount: '5' }]);
  const lost = C.summarizeResult({ status: { SuccessValue: b64json('1') }, receipts_outcome: [okReceipt(), { id: 'r', outcome: { logs: [], status: { Failure: {} } } }] }, 'H');
  assert.equal(lost.settlement, 'unconfirmed');
  assert.deepEqual(lost.payoutsFailed, []);
  const fine = C.summarizeResult({ status: { SuccessValue: b64json('1') }, receipts_outcome: [okReceipt()] }, 'H');
  assert.equal(fine.settlement, 'settled');
});
