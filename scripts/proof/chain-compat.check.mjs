// Compares the page's own transaction encoding and signing (web/chain.js) with
// near-api-js 5.1.1, byte for byte. Runs only where near-api-js is installed, which is
// inside the GitHub Actions jobs that install it; the file name keeps it out of the
// `*.test.mjs` runs that need no dependency.
//
//   node --test scripts/proof/chain-compat.check.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import nearApi from 'near-api-js';
import * as C from '../../web/chain.js';

const { KeyPair, transactions: T, utils } = nearApi;
const { base_decode: b58decode, base_encode: b58encode } = utils.serialize;
const hex = (bytes) => Buffer.from(bytes).toString('hex');

const CASES = [
  { method: 'buy', args: { min_tokens_out: '1' }, gas: 50n, deposit: 2n * 10n ** 24n, nonce: 1n },
  { method: 'shout', args: { amount: '19607843137254901960784313' }, gas: 30n, deposit: 1n, nonce: 123456789012345n },
  { method: 'leave', args: { exit_id: '7', min_near_out: '0' }, gas: 80n, deposit: 1n, nonce: 2n ** 53n + 11n },
  { method: 'catch', args: { exit_id: '7', amount: '4901960784313725490196078' }, gas: 120n, deposit: 340282366920938463463374607431768211455n, nonce: 42n },
  { method: 'storage_deposit', args: { account_id: 'someone-else.testnet', note: 'ünïcödé ✓' }, gas: 30n, deposit: 3n * 10n ** 22n, nonce: 7n },
];

test('web/chain.js encodes and signs exactly as near-api-js does', async () => {
  const keys = await C.generateKeyPair();
  const kp = KeyPair.fromString(keys.secretKey);
  // The key pair string is read the same way by both.
  assert.equal(kp.getPublicKey().toString(), keys.publicKey);
  const blockHash = b58encode(createHash('sha256').update('a block').digest());
  for (const c of CASES) {
    const signerId = 'loud-try-compat.testnet';
    const receiverId = 't.loud-live-compat.testnet';
    const tx = T.createTransaction(signerId, kp.getPublicKey(), receiverId, c.nonce,
      [T.functionCall(c.method, c.args, c.gas * 10n ** 12n, c.deposit)], b58decode(blockHash));
    const theirs = tx.encode();
    const ours = C.encodeTransaction({
      signerId, publicKey: keys.publicKey, nonce: c.nonce, receiverId, blockHash,
      method: c.method, args: c.args, gas: c.gas * 10n ** 12n, deposit: c.deposit,
    });
    assert.equal(hex(ours), hex(theirs), `transaction bytes of ${c.method}`);

    const digest = new Uint8Array(createHash('sha256').update(theirs).digest());
    const { signature } = kp.sign(digest);
    const theirSigned = new T.SignedTransaction({
      transaction: tx,
      signature: new T.Signature({ keyType: tx.publicKey.keyType, data: signature }),
    }).encode();
    const signed = await C.signTransaction(keys.secretKey, ours);
    assert.equal(signed.hash, b58encode(digest), `hash of ${c.method}`);
    assert.equal(hex(signed.signedBytes), hex(theirSigned), `signed bytes of ${c.method}`);
    assert.equal(signed.signedBase64, Buffer.from(theirSigned).toString('base64'));
  }
});

test('a key pair made by near-api-js signs through web/chain.js', async () => {
  const kp = KeyPair.fromRandom('ed25519');
  const secretKey = kp.toString();
  const msg = new Uint8Array(createHash('sha256').update('message').digest());
  const ours = await C.signBytes(secretKey, msg);
  assert.equal(hex(ours), hex(kp.sign(msg).signature));
  assert.deepEqual(C.importWallet({ accountId: 'x.testnet', publicKey: kp.getPublicKey().toString(), secretKey }),
    { accountId: 'x.testnet', publicKey: kp.getPublicKey().toString(), secretKey });
});
