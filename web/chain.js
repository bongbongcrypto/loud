// NEAR testnet client for the page: keys, signing, sending and reading, with no dependency.
// Works in browsers and in Node 22+ (WebCrypto Ed25519, fetch). Testnet only.
//
// A transaction is borsh(Transaction); its hash is sha256 of those bytes and its signature
// is the ed25519 signature of the hash. The layout written here is the one NEAR nodes
// accept (nearcore `Transaction`, version 0): signer_id, public_key, nonce, receiver_id,
// block_hash, actions. Only the FunctionCall action is encoded; the page needs no other.

export const NETWORK = 'testnet';
// FastNEAR first: docs.near.org lists the near.org endpoints as severely rate limited.
export const RPC_URLS = [
  'https://test.rpc.fastnear.com',
  'https://rpc.testnet.fastnear.com',
  'https://rpc.testnet.near.org',
  'https://near-testnet.drpc.org',
];
// Testnet account faucet: POST { newAccountId, newAccountPublicKey }.
export const FAUCET_URLS = [
  'https://helper.nearprotocol.com/account',
  'https://helper.testnet.near.org/account',
];
export const EXPLORER = 'https://testnet.nearblocks.io';
export const TGAS = 10n ** 12n;
export const YOCTO = 10n ** 24n;

export const txUrl = (hash) => `${EXPLORER}/txns/${hash}`;
export const accountUrl = (id) => `${EXPLORER}/address/${id}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------------------------------------------------------------------------------------
// Bytes: base58, base64, borsh
// ---------------------------------------------------------------------------------------

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(bytes) {
  const src = Uint8Array.from(bytes);
  let zeros = 0;
  while (zeros < src.length && src[zeros] === 0) zeros += 1;
  let n = 0n;
  for (const b of src) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  return '1'.repeat(zeros) + out;
}

export function base58Decode(text) {
  const s = String(text);
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros += 1;
  let n = 0n;
  for (const ch of s) {
    const v = B58.indexOf(ch);
    if (v < 0) throw new Error('not base58');
    n = n * 58n + BigInt(v);
  }
  const body = [];
  while (n > 0n) {
    body.unshift(Number(n % 256n));
    n /= 256n;
  }
  return Uint8Array.from([...new Array(zeros).fill(0), ...body]);
}

export function base64Encode(bytes) {
  let bin = '';
  const src = Uint8Array.from(bytes);
  for (let i = 0; i < src.length; i += 0x8000) bin += String.fromCharCode(...src.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function base64Decode(text) {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function uintLE(value, bytes) {
  let v = BigInt(value);
  if (v < 0n || v >= 1n << BigInt(8 * bytes)) throw new Error(`value does not fit ${bytes} bytes`);
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

const borshString = (text) => {
  const b = enc.encode(text);
  return concat([uintLE(b.length, 4), b]);
};

// 'ed25519:<base58 of 32 bytes>' -> 32 bytes
export function publicKeyBytes(publicKey) {
  const [curve, body] = String(publicKey).split(':');
  if (curve !== 'ed25519' || !body) throw new Error('only ed25519 public keys are supported');
  const b = base58Decode(body);
  if (b.length !== 32) throw new Error('an ed25519 public key has 32 bytes');
  return b;
}

// borsh(Transaction) with one FunctionCall action.
//   args: object (sent as JSON) or Uint8Array; gas and deposit: BigInt or decimal string.
export function encodeTransaction({ signerId, publicKey, nonce, receiverId, blockHash, method, args = {}, gas, deposit = 0n }) {
  const block = typeof blockHash === 'string' ? base58Decode(blockHash) : Uint8Array.from(blockHash);
  if (block.length !== 32) throw new Error('a block hash has 32 bytes');
  const argBytes = args instanceof Uint8Array ? args : enc.encode(JSON.stringify(args));
  return concat([
    borshString(signerId),
    Uint8Array.of(0), publicKeyBytes(publicKey), // PublicKey enum: 0 = ed25519
    uintLE(nonce, 8),
    borshString(receiverId),
    block,
    uintLE(1, 4), // one action
    Uint8Array.of(2), // Action enum: 2 = FunctionCall
    borshString(method),
    uintLE(argBytes.length, 4), argBytes,
    uintLE(gas, 8),
    uintLE(deposit, 16),
  ]);
}

// borsh(SignedTransaction) = borsh(Transaction) + Signature enum (0 = ed25519) + 64 bytes
export function encodeSignedTransaction(txBytes, signature) {
  if (signature.length !== 64) throw new Error('an ed25519 signature has 64 bytes');
  return concat([txBytes, Uint8Array.of(0), signature]);
}

export async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

// ---------------------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------------------

// PKCS#8 wrapper of a raw 32-byte Ed25519 seed (RFC 8410): this fixed prefix, then the seed.
const PKCS8_PREFIX = Uint8Array.of(0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20);

// -> { publicKey: 'ed25519:...', secretKey: 'ed25519:<base58 of seed + public key>' }
// The secret key string has the form near-cli and near-api-js use.
export async function generateKeyPair() {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const seed = pkcs8.slice(pkcs8.length - 32);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { publicKey: `ed25519:${base58Encode(pub)}`, secretKey: `ed25519:${base58Encode(concat([seed, pub]))}` };
}

function secretParts(secretKey) {
  const [curve, body] = String(secretKey).split(':');
  if (curve !== 'ed25519' || !body) throw new Error('only ed25519 secret keys are supported');
  const b = base58Decode(body);
  if (b.length !== 64 && b.length !== 32) throw new Error('an ed25519 secret key has 64 bytes (seed and public key)');
  return { seed: b.slice(0, 32), pub: b.length === 64 ? b.slice(32) : null };
}

const signingKeys = new Map(); // secretKey string -> Promise<CryptoKey>
function signingKey(secretKey) {
  if (!signingKeys.has(secretKey)) {
    const { seed } = secretParts(secretKey);
    signingKeys.set(secretKey, crypto.subtle.importKey('pkcs8', concat([PKCS8_PREFIX, seed]), { name: 'Ed25519' }, false, ['sign']));
  }
  return signingKeys.get(secretKey);
}

export async function signBytes(secretKey, bytes) {
  return new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, await signingKey(secretKey), bytes));
}

// Sign a serialized transaction. -> { hash (base58), signedBytes, signedBase64 }
export async function signTransaction(secretKey, txBytes) {
  const digest = await sha256(txBytes);
  const signature = await signBytes(secretKey, digest);
  const signedBytes = encodeSignedTransaction(txBytes, signature);
  return { hash: base58Encode(digest), signedBytes, signedBase64: base64Encode(signedBytes) };
}

// A wallet is a plain object: { accountId, publicKey, secretKey }. Nothing else is kept.
export function exportWallet(w) {
  return { accountId: String(w.accountId), publicKey: String(w.publicKey), secretKey: String(w.secretKey) };
}

export function importWallet(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('not a wallet');
  const w = exportWallet(obj);
  if (!/^[a-z0-9._-]{2,64}$/.test(w.accountId)) throw new Error('not a NEAR account id');
  const { pub } = secretParts(w.secretKey);
  const fromPublic = publicKeyBytes(w.publicKey);
  if (pub && base58Encode(pub) !== base58Encode(fromPublic)) throw new Error('the secret key does not belong to the public key');
  return w;
}

// ---------------------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------------------

export class RpcError extends Error {
  constructor(error) {
    const text = JSON.stringify(error).slice(0, 600);
    super(text);
    this.name = 'RpcError';
    this.rpcName = error?.name ?? null;
    this.cause_ = error?.cause?.name ?? null;
    this.text = text;
  }
}

let rpcAt = 0;
let rpcId = 0;
const config = { rpcUrls: RPC_URLS, faucetUrls: FAUCET_URLS, fetch: (...a) => fetch(...a), timeoutMs: 30_000 };

// For tests and for a page that wants another endpoint order.
export function configure(options = {}) {
  Object.assign(config, options);
  rpcAt = 0;
}

// One JSON-RPC call. Transport problems rotate to the next URL; named NEAR errors are thrown.
export async function rpc(method, params, { tries = 6 } = {}) {
  let last = null;
  const urls = config.rpcUrls;
  for (let attempt = 0; attempt < tries; attempt++) {
    const url = urls[rpcAt % urls.length];
    try {
      const res = await config.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      if (res.status === 429) throw new Error('HTTP 429 (rate limited)');
      let body = null;
      try {
        body = await res.json();
      } catch {
        throw new Error(`HTTP ${res.status} with a non-JSON body`);
      }
      if (body && body.error) {
        const err = new RpcError(body.error);
        if (err.rpcName === 'INTERNAL_ERROR' || (!err.rpcName && !err.cause_)) throw new Error(`endpoint error ${err.text.slice(0, 160)}`);
        throw err;
      }
      if (!res.ok || !body || body.result === undefined) throw new Error(`HTTP ${res.status} without a result`);
      return body.result;
    } catch (e) {
      if (e instanceof RpcError) throw e;
      last = e;
      rpcAt += 1;
      await sleep(Math.min(400 * 2 ** attempt, 4000));
    }
  }
  throw new Error(`NEAR RPC ${method} failed on every endpoint: ${last?.message}`);
}

const query = (params) => rpc('query', { finality: 'final', ...params });

// Call a view method and parse its JSON result.
export async function view(contractId, method, args = {}) {
  const r = await query({
    request_type: 'call_function',
    account_id: contractId,
    method_name: method,
    args_base64: base64Encode(enc.encode(JSON.stringify(args))),
  });
  if (r.error) throw new Error(`view ${method}: ${String(r.error).slice(0, 300)}`);
  return JSON.parse(dec.decode(Uint8Array.from(r.result)));
}

// -> { exists, amountYocto }
export async function accountState(accountId) {
  try {
    const r = await query({ request_type: 'view_account', account_id: accountId });
    return { exists: true, amountYocto: String(r.amount) };
  } catch (e) {
    if (e instanceof RpcError && e.cause_ === 'UNKNOWN_ACCOUNT') return { exists: false, amountYocto: '0' };
    throw e;
  }
}

// -> { nonce, block_hash } or null when the key is not on the account
async function accessKey(accountId, publicKey) {
  try {
    const r = await query({ request_type: 'view_access_key', account_id: accountId, public_key: publicKey });
    return r.error ? null : r;
  } catch (e) {
    if (e instanceof RpcError && (e.cause_ === 'UNKNOWN_ACCESS_KEY' || e.cause_ === 'UNKNOWN_ACCOUNT')) return null;
    throw e;
  }
}

// ---------------------------------------------------------------------------------------
// Reading a transaction result
// ---------------------------------------------------------------------------------------

// Text of a failed execution status, e.g. the contract panic message.
export function failureText(failure) {
  if (failure === undefined || failure === null) return null;
  const s = typeof failure === 'string' ? failure : JSON.stringify(failure);
  const m = s.match(/Smart contract panicked: ((?:[^"\\]|\\.)*)/);
  return (m ? m[1] : s).slice(0, 400);
}

// First error code of the contract (E_...) found in a text, or null.
export function errorCode(text) {
  if (!text) return null;
  const m = String(text).match(/\bE_[A-Z][A-Z_]*[A-Z]\b/);
  return m ? m[0] : null;
}

// NEP-297 events from receipt logs: [{ standard, event, data }]
export function parseEvents(logs) {
  const out = [];
  for (const line of Array.isArray(logs) ? logs : []) {
    if (typeof line !== 'string' || !line.startsWith('EVENT_JSON:')) continue;
    try {
      const ev = JSON.parse(line.slice('EVENT_JSON:'.length));
      const data = Array.isArray(ev.data) ? ev.data[0] : ev.data;
      out.push({ standard: ev.standard, event: ev.event, data: data ?? {} });
    } catch {
      // not an event
    }
  }
  return out;
}

// The contract pays NEAR with a detached transfer and a callback, so a failed payout does
// not change the top-level status. `settled` is true when the call succeeded, every receipt
// outcome succeeded and no log carries a `payout_failed` event.
export function receiptSettlement(result) {
  const outcomes = Array.isArray(result?.receipts_outcome) ? result.receipts_outcome : [];
  let failed = 0;
  for (const r of outcomes) {
    if (parseEvents(r?.outcome?.logs).some((e) => e.standard === 'loud' && e.event === 'payout_failed')) failed += 1;
    const st = r?.outcome?.status;
    const ok = st !== null && typeof st === 'object'
      && (typeof st.SuccessValue === 'string' || typeof st.SuccessReceiptId === 'string');
    if (!ok) failed += 1;
  }
  const top = result?.status;
  const topOk = top !== null && typeof top === 'object' && typeof top.SuccessValue === 'string';
  return { receipts: outcomes.length, failed, settled: topOk && outcomes.length > 0 && failed === 0 };
}

// RPC transaction result -> the object `call` returns.
export function summarizeResult(result, hash) {
  const logs = (result.receipts_outcome ?? []).flatMap((r) => r.outcome?.logs ?? []);
  const failure = result.status?.Failure;
  const errorMessage = failure === undefined ? null : failureText(failure);
  let value = null;
  if (typeof result.status?.SuccessValue === 'string' && result.status.SuccessValue !== '') {
    try {
      value = JSON.parse(dec.decode(base64Decode(result.status.SuccessValue)));
    } catch {
      value = null;
    }
  }
  const h = result.transaction?.hash ?? hash;
  return {
    ok: failure === undefined,
    outcome: failure === undefined ? 'success' : 'failure',
    hash: h,
    value,
    errorCode: errorCode(errorMessage),
    errorMessage,
    logs,
    events: parseEvents(logs),
    explorerUrl: h ? txUrl(h) : null,
    settled: receiptSettlement(result).settled,
  };
}

// ---------------------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------------------

const nonces = new Map(); // `${accountId} ${publicKey}` -> BigInt, the last nonce used
let recentBlock = { hash: null, at: 0 };

async function recentBlockHash() {
  if (!recentBlock.hash || Date.now() - recentBlock.at > 30_000) {
    const r = await rpc('block', { finality: 'final' });
    recentBlock = { hash: r.header.hash, at: Date.now() };
  }
  return recentBlock.hash;
}

async function nextNonce(wallet) {
  const id = `${wallet.accountId} ${wallet.publicKey}`;
  if (!nonces.has(id)) {
    let key = null;
    for (let i = 0; i < 12 && !key; i++) {
      key = await accessKey(wallet.accountId, wallet.publicKey);
      if (!key) await sleep(1500);
    }
    if (!key) throw new Error(`the key of ${wallet.accountId} is not on chain`);
    nonces.set(id, BigInt(key.nonce));
  }
  const n = nonces.get(id) + 1n;
  nonces.set(id, n);
  return n;
}

async function sendAndWait(signedBase64, hash, senderId, maxWaitMs = 90_000) {
  try {
    return await rpc('send_tx', { signed_tx_base64: signedBase64, wait_until: 'FINAL' });
  } catch (e) {
    // A node-side timeout is not a failure: the transaction is then polled by hash.
    const timeout = e instanceof RpcError ? e.cause_ === 'TIMEOUT_ERROR' : true;
    if (!timeout) throw e;
  }
  const until = Date.now() + maxWaitMs;
  let last = null;
  while (Date.now() < until) {
    try {
      return await rpc('tx', { tx_hash: hash, sender_account_id: senderId, wait_until: 'FINAL' });
    } catch (e) {
      const pending = e instanceof RpcError && (e.cause_ === 'TIMEOUT_ERROR' || e.cause_ === 'UNKNOWN_TRANSACTION');
      if (e instanceof RpcError && !pending) throw e;
      last = e;
      await sleep(2000);
    }
  }
  throw new Error(`transaction ${hash} was not final after ${maxWaitMs / 1000} s: ${last?.message ?? ''}`);
}

// Sign and send one function call and wait until it is final.
// -> { ok, outcome, hash, value, errorCode, errorMessage, logs, events, explorerUrl, settled }
//   outcome "success": executed. "failure": executed and failed (a contract panic gives
//   errorCode E_...). "invalid": a node refused the transaction, nothing executed.
// Throws only when no endpoint could be reached or the result never became final.
export async function call(wallet, contractId, method, args = {}, { gasTgas = 100, depositYocto = '0' } = {}) {
  let hash = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const txBytes = encodeTransaction({
        signerId: wallet.accountId,
        publicKey: wallet.publicKey,
        nonce: await nextNonce(wallet),
        receiverId: contractId,
        blockHash: await recentBlockHash(),
        method,
        args,
        gas: BigInt(gasTgas) * TGAS,
        deposit: BigInt(depositYocto),
      });
      const signed = await signTransaction(wallet.secretKey, txBytes);
      hash = signed.hash;
      return summarizeResult(await sendAndWait(signed.signedBase64, hash, wallet.accountId), hash);
    } catch (e) {
      if (!(e instanceof RpcError)) throw e;
      if (/InvalidNonce|Expired/.test(e.text) && attempt < 2) {
        nonces.delete(`${wallet.accountId} ${wallet.publicKey}`);
        recentBlock = { hash: null, at: 0 };
        continue;
      }
      const errorMessage = e.text.slice(0, 400);
      return {
        ok: false, outcome: 'invalid', hash, value: null, errorCode: errorCode(errorMessage), errorMessage,
        logs: [], events: [], explorerUrl: null, settled: false,
      };
    }
  }
  throw new Error('unreachable');
}

// ---------------------------------------------------------------------------------------
// Test wallets
// ---------------------------------------------------------------------------------------

function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Create a key pair and ask the testnet faucet for a funded account that it controls.
// -> { accountId, publicKey, secretKey }. Throws when no faucet created the account.
export async function createTestWallet({ prefix = 'loud-try' } = {}) {
  const keys = await generateKeyPair();
  const accountId = `${prefix}-${Date.now().toString(36)}${randomHex(3)}.testnet`;
  const errors = [];
  for (const url of config.faucetUrls) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      let note;
      let polls = 12;
      try {
        const res = await config.fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: keys.publicKey }),
          signal: AbortSignal.timeout(60_000),
        });
        const text = (await res.text()).replace(/\s+/g, ' ').slice(0, 160);
        note = `HTTP ${res.status} ${text}`;
        if (!res.ok) polls = 2;
      } catch (e) {
        note = `request failed: ${e.message}`;
      }
      // The account may exist even when the HTTP call failed, so the chain decides.
      for (let i = 0; i < polls; i++) {
        if (await accessKey(accountId, keys.publicKey)) return { accountId, ...keys };
        await sleep(1500);
      }
      errors.push(`${new URL(url).host}: ${note}`);
      await sleep(2000 * attempt);
    }
  }
  throw new Error(`the testnet faucet did not create ${accountId}. ${errors.join(' | ')}`);
}
