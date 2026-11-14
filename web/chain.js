// NEAR testnet client for the page: keys, signing, sending and reading, with no dependency.
// Works in browsers and in Node 22+ (WebCrypto Ed25519, fetch). Testnet only.
//
// A transaction is borsh(Transaction); its hash is sha256 of those bytes and its signature
// is the ed25519 signature of the hash. The layout written here is the one NEAR nodes
// accept (nearcore `Transaction`, version 0): signer_id, public_key, nonce, receiver_id,
// block_hash, actions. Encoded actions: FunctionCall, and CreateAccount, Transfer and
// AddKey (full access) for the second wallet.

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

// Actions. The page uses FunctionCall; CreateAccount, Transfer and AddKey (full access)
// make a second wallet as a sub-account of the first, in one transaction.
//   args: object (sent as JSON) or Uint8Array; gas and deposit: BigInt or decimal string.
export const functionCall = (method, args = {}, gas, deposit = 0n) => ({ type: 'FunctionCall', method, args, gas, deposit });
export const createAccount = () => ({ type: 'CreateAccount' });
export const transfer = (deposit) => ({ type: 'Transfer', deposit });
export const addFullAccessKey = (publicKey) => ({ type: 'AddKey', publicKey });

// borsh(Action). Enum tags as in nearcore: 0 CreateAccount, 2 FunctionCall, 3 Transfer,
// 5 AddKey. AddKey carries the PublicKey and an AccessKey { nonce: u64 = 0, permission },
// and the permission enum is 1 = FullAccess.
export function encodeAction(action) {
  if (action.type === 'FunctionCall') {
    const argBytes = action.args instanceof Uint8Array ? action.args : enc.encode(JSON.stringify(action.args ?? {}));
    return concat([
      Uint8Array.of(2),
      borshString(action.method),
      uintLE(argBytes.length, 4), argBytes,
      uintLE(action.gas, 8),
      uintLE(action.deposit ?? 0n, 16),
    ]);
  }
  if (action.type === 'CreateAccount') return Uint8Array.of(0);
  if (action.type === 'Transfer') return concat([Uint8Array.of(3), uintLE(action.deposit, 16)]);
  if (action.type === 'AddKey') {
    return concat([Uint8Array.of(5), Uint8Array.of(0), publicKeyBytes(action.publicKey), uintLE(0, 8), Uint8Array.of(1)]);
  }
  throw new Error(`action ${action.type} is not supported`);
}

// borsh(Transaction). Either `actions` (a list made with the helpers above) or the fields
// of one FunctionCall (method, args, gas, deposit).
export function encodeTransaction({ signerId, publicKey, nonce, receiverId, blockHash, actions, method, args = {}, gas, deposit = 0n }) {
  const block = typeof blockHash === 'string' ? base58Decode(blockHash) : Uint8Array.from(blockHash);
  if (block.length !== 32) throw new Error('a block hash has 32 bytes');
  const list = actions ?? [functionCall(method, args, gas, deposit)];
  if (!Array.isArray(list) || list.length === 0) throw new Error('a transaction needs at least one action');
  return concat([
    borshString(signerId),
    Uint8Array.of(0), publicKeyBytes(publicKey), // PublicKey enum: 0 = ed25519
    uintLE(nonce, 8),
    borshString(receiverId),
    block,
    uintLE(list.length, 4),
    ...list.map(encodeAction),
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

// 'ed25519:...' secret key (32-byte seed, or seed and public key) -> 'ed25519:<public key>'.
// The public key is derived from the seed, so a 64-byte key whose second half does not
// match is refused.
export async function publicKeyFromSecret(secretKey) {
  const { seed, pub } = secretParts(secretKey);
  const key = await crypto.subtle.importKey('pkcs8', concat([PKCS8_PREFIX, seed]), { name: 'Ed25519' }, true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', key);
  const derived = base64Decode(jwk.x.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(jwk.x.length / 4) * 4, '='));
  if (pub && base58Encode(pub) !== base58Encode(derived)) throw new Error('the secret key is not a valid ed25519 key pair');
  return `ed25519:${base58Encode(derived)}`;
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
// timeoutMs: one HTTP request. confirmMs: how long `call` keeps looking for the result of
// a transaction it has broadcast before it reports the outcome as unknown.
const config = { rpcUrls: RPC_URLS, faucetUrls: FAUCET_URLS, fetch: (...a) => fetch(...a), timeoutMs: 30_000, confirmMs: 90_000 };

// For tests and for a page that wants another endpoint order. Forgets cached nonces and
// the cached block hash.
export function configure(options = {}) {
  Object.assign(config, options);
  rpcAt = 0;
  nonces.clear();
  recentBlock = { hash: null, at: 0 };
}

// One JSON-RPC request to one URL. A named NEAR error is thrown as RpcError; anything
// else (network, HTTP status, a body that is not JSON-RPC) as a plain Error.
async function rpcOnce(url, method, params, timeoutMs = config.timeoutMs) {
  const res = await config.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    signal: AbortSignal.timeout(Math.max(1000, timeoutMs)),
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
}

// One JSON-RPC call. Transport problems rotate to the next URL; named NEAR errors are thrown.
// Not used for sending transactions: see `submit`.
export async function rpc(method, params, { tries = 6 } = {}) {
  let last = null;
  const urls = config.rpcUrls;
  for (let attempt = 0; attempt < tries; attempt++) {
    const url = urls[rpcAt % urls.length];
    try {
      return await rpcOnce(url, method, params);
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

function viewParams(contractId, method, args, blockId) {
  return {
    request_type: 'call_function',
    account_id: contractId,
    method_name: method,
    args_base64: base64Encode(enc.encode(JSON.stringify(args))),
    ...(blockId === undefined || blockId === null ? { finality: 'final' } : { block_id: blockId }),
  };
}

function viewValue(method, r) {
  if (r.error) throw new Error(`view ${method}: ${String(r.error).slice(0, 300)}`);
  return JSON.parse(dec.decode(Uint8Array.from(r.result)));
}

// Call a view method and parse its JSON result.
export async function view(contractId, method, args = {}) {
  return viewValue(method, await rpc('query', viewParams(contractId, method, args)));
}

// The same, with the block it was read at; `blockId` (a height) pins the read to that block.
// -> { value, blockHeight }
export async function viewAt(contractId, method, args = {}, blockId = null) {
  const r = await rpc('query', viewParams(contractId, method, args, blockId));
  return { value: viewValue(method, r), blockHeight: typeof r.block_height === 'number' ? r.block_height : null };
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

// -> { nonce, permission, block_hash } or null when the key is not on the account
export async function accessKey(accountId, publicKey) {
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
  const events = parseEvents(logs);
  const settled = receiptSettlement(result).settled;
  // Payouts the contract recorded as owed (claim pays them): [{ account, amount }]
  const payoutsFailed = events.filter((e) => e.standard === 'loud' && e.event === 'payout_failed')
    .map((e) => ({ account: String(e.data.account ?? ''), amount: String(e.data.amount ?? '0') }));
  return {
    ok: failure === undefined,
    outcome: failure === undefined ? 'success' : 'failure',
    hash: h,
    value,
    errorCode: errorCode(errorMessage),
    errorMessage,
    logs,
    events,
    explorerUrl: h ? txUrl(h) : null,
    settled,
    // For a successful call: 'settled'; 'payout_failed' when a payout came back and was
    // recorded for `claim`; 'unconfirmed' when a receipt did not succeed for another reason.
    settlement: failure !== undefined ? null : settled ? 'settled' : payoutsFailed.length ? 'payout_failed' : 'unconfirmed',
    payoutsFailed,
  };
}

// ---------------------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------------------

// Raised before anything is broadcast; `call` turns it into a result with hash null.
class NotSent extends Error {}

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
    if (!key) throw new NotSent(`the key of ${wallet.accountId} is not on chain: the account does not exist or does not carry this key`);
    nonces.set(id, BigInt(key.nonce));
  }
  const n = nonces.get(id) + 1n;
  nonces.set(id, n);
  return n;
}

const isNonceRefusal = (e) => e instanceof RpcError && /InvalidNonce|Expired/.test(e.text);
// A node's answer that the transaction was not taken: it is invalid (INVALID_TRANSACTION),
// or the request itself was malformed. Any other error may come after the node passed
// the transaction on, so it counts as "may have been sent".
const isCertainRefusal = (e) => e instanceof RpcError
  && (e.cause_ === 'INVALID_TRANSACTION' || e.rpcName === 'REQUEST_VALIDATION_ERROR');

// Asks every endpoint once for the final outcome of a transaction.
// -> { result } when a node returned it, else { result: null, seen } where `seen` means a
// node knows the transaction but has no final outcome yet.
async function lookupByHash(hash, senderId, deadline) {
  let seen = false;
  for (const url of config.rpcUrls) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    try {
      const result = await rpcOnce(url, 'tx', { tx_hash: hash, sender_account_id: senderId, wait_until: 'FINAL' }, Math.min(config.timeoutMs, left));
      return { result, seen: true };
    } catch (e) {
      if (e instanceof RpcError && e.cause_ === 'TIMEOUT_ERROR') seen = true;
    }
  }
  return { result: null, seen };
}

// Broadcasts one signed transaction and waits for its final outcome. Only these signed
// bytes are ever sent again, so the transaction can execute at most once.
// -> { kind: 'final', result }
//    { kind: 'refused', error }: a node refused it before anything could have been accepted
//    { kind: 'unknown', error }: it may have been accepted; no final outcome in time
async function submit(signedBase64, hash, senderId) {
  const urls = config.rpcUrls;
  const deadline = Date.now() + config.confirmMs;
  let maybeSent = false; // a request carrying these bytes may have reached a node
  let last = null;

  // Broadcast at most once per endpoint. After a request that may have reached a node,
  // look the hash up everywhere before sending the same bytes to the next endpoint.
  for (let i = 0; i < urls.length && Date.now() < deadline; i++) {
    if (maybeSent) {
      const found = await lookupByHash(hash, senderId, deadline);
      if (found.result) return { kind: 'final', result: found.result };
      if (found.seen) break;
    }
    const url = urls[(rpcAt + i) % urls.length];
    try {
      const result = await rpcOnce(url, 'send_tx', { signed_tx_base64: signedBase64, wait_until: 'FINAL' }, Math.min(config.timeoutMs, deadline - Date.now()));
      return { kind: 'final', result };
    } catch (e) {
      last = e;
      if (!(e instanceof RpcError)) {
        maybeSent = true; // transport error: the node may have taken it
        continue;
      }
      // TIMEOUT_ERROR: the node took the transaction and has no final outcome yet.
      if (e.cause_ === 'TIMEOUT_ERROR') {
        maybeSent = true;
        break;
      }
      // Another error than a refusal: the node may have passed it on.
      if (!isCertainRefusal(e)) {
        maybeSent = true;
        continue;
      }
      // A refusal before any earlier request could have landed is certain.
      if (!maybeSent) return { kind: 'refused', error: e };
      // After one that may have landed, a refusal (InvalidNonce above all) can mean the
      // first one executed: only the hash can tell.
      break;
    }
  }
  if (!maybeSent) return { kind: 'unknown', error: last ?? new Error('no endpoint was tried') };

  // Look the hash up until the deadline. When no node knows the transaction, the same
  // bytes go out again now and then; a node that has it already refuses them.
  for (let round = 1; Date.now() < deadline; round++) {
    const found = await lookupByHash(hash, senderId, deadline);
    if (found.result) return { kind: 'final', result: found.result };
    if (!found.seen && round % 3 === 0 && Date.now() < deadline) {
      try {
        await rpcOnce(urls[(rpcAt + round) % urls.length], 'broadcast_tx_async', [signedBase64], Math.min(config.timeoutMs, deadline - Date.now()));
      } catch (e) {
        last = e;
      }
    }
    await sleep(2000);
  }
  return { kind: 'unknown', error: last };
}

const emptyResult = {
  ok: false, value: null, errorCode: null, logs: [], events: [], settled: false, settlement: null, payoutsFailed: [],
};

// Sign and send one transaction with the given actions and wait until it is final.
// The result has the shape `call` documents.
export async function sendActions(wallet, receiverId, actions) {
  const signedHashes = []; // every transaction signed for this call, in order
  const id = `${wallet.accountId} ${wallet.publicKey}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    let signed;
    try {
      const txBytes = encodeTransaction({
        signerId: wallet.accountId,
        publicKey: wallet.publicKey,
        nonce: await nextNonce(wallet),
        receiverId,
        blockHash: await recentBlockHash(),
        actions,
      });
      signed = await signTransaction(wallet.secretKey, txBytes);
    } catch (e) {
      // Nothing of this attempt was broadcast, and every earlier one was refused.
      if (e instanceof NotSent) {
        return { ...emptyResult, outcome: 'invalid', hash: null, refusedHash: signedHashes.at(-1) ?? null, errorMessage: e.message, explorerUrl: null, signedHashes };
      }
      throw e;
    }
    signedHashes.push(signed.hash);
    let sent;
    try {
      sent = await submit(signed.signedBase64, signed.hash, wallet.accountId);
    } catch (e) {
      sent = { kind: 'unknown', error: e };
    }
    if (sent.kind === 'final') return { ...summarizeResult(sent.result, signed.hash), refusedHash: null, signedHashes };
    if (sent.kind === 'unknown') {
      const why = sent.error && sent.error.message ? `: ${sent.error.message.slice(0, 200)}` : '';
      return {
        ...emptyResult,
        outcome: 'unknown',
        hash: signed.hash,
        refusedHash: null,
        errorMessage: `The transaction was sent, but no node returned its final outcome within ${Math.round(config.confirmMs / 1000)} s${why}`,
        explorerUrl: txUrl(signed.hash),
        signedHashes,
      };
    }
    // Refused for certain: nothing executed. Only a stale nonce or block hash is worth a
    // new signature, and only because no node can have accepted the refused one.
    if (isNonceRefusal(sent.error) && attempt < 2) {
      nonces.delete(id);
      recentBlock = { hash: null, at: 0 };
      continue;
    }
    const errorMessage = sent.error.text.slice(0, 400);
    return {
      ...emptyResult, outcome: 'invalid', hash: null, refusedHash: signed.hash, errorCode: errorCode(errorMessage), errorMessage, explorerUrl: null, signedHashes,
    };
  }
  throw new Error('unreachable');
}

// Sign and send one function call and wait until it is final.
// -> { ok, outcome, hash, value, errorCode, errorMessage, logs, events, explorerUrl, settled,
//      settlement, payoutsFailed, refusedHash, signedHashes }
//   outcome "success": executed. "failure": executed and failed (a contract panic gives
//   errorCode E_... and errorMessage the full text). "invalid": nothing executed, because
//   a node refused the transaction or it could not be signed for this account; hash is
//   null then, since there is nothing on chain to look at (`refusedHash` names a
//   transaction that a node refused). "unknown": the transaction was broadcast and may
//   still execute, but no node returned its final outcome in time; hash and explorerUrl
//   name it.
// A transaction is signed again only after a node refused it for certain (a stale nonce or
// block hash, before any other copy could have been accepted). After a broadcast that may
// have reached a node, the hash is looked up instead, and only the same signed bytes are
// sent again, so one call executes at most one transaction.
// Throws only before anything was broadcast (no endpoint could be reached).
export async function call(wallet, contractId, method, args = {}, { gasTgas = 100, depositYocto = '0' } = {}) {
  return sendActions(wallet, contractId, [functionCall(method, args, BigInt(gasTgas) * TGAS, BigInt(depositYocto))]);
}

// ---------------------------------------------------------------------------------------
// Test wallets
// ---------------------------------------------------------------------------------------

function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// What the faucet answered, kept on the error: HTTP status (null when no answer came)
// and the start of its body.
export class FaucetError extends Error {
  constructor(message, { status = null, answer = '' } = {}) {
    super(message);
    this.name = 'FaucetError';
    this.status = status;
    this.answer = answer;
  }
}

// Create a key pair and ask the testnet faucet for a funded account that it controls.
// -> { accountId, publicKey, secretKey }. Throws a FaucetError when no faucet created it.
// The public faucet limits accounts per caller address, so any HTTP answer that is not a
// success ends the attempt: one request, no retry. Only a request that got no HTTP answer
// at all (network error) moves on to the next faucet URL, with the same account id and key.
// `onAnswer({ host, status, text })` sees each answer.
export async function createTestWallet({ prefix = 'loud-try', onAnswer = null } = {}) {
  const keys = await generateKeyPair();
  const accountId = `${prefix}-${Date.now().toString(36)}${randomHex(3)}.testnet`;
  const errors = [];
  let status = null;
  let text = '';
  for (const url of config.faucetUrls) {
    const host = new URL(url).host;
    status = null;
    try {
      const res = await config.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: keys.publicKey }),
        signal: AbortSignal.timeout(60_000),
      });
      status = res.status;
      text = (await res.text()).replace(/\s+/g, ' ').trim().slice(0, 300);
    } catch (e) {
      text = `request failed: ${e.message}`;
    }
    if (onAnswer) onAnswer({ host, status, text });
    const refused = status !== null && status >= 300;
    // The account may exist even when the HTTP call failed, so the chain decides.
    const polls = status !== null && status < 300 ? 12 : refused ? 1 : 4;
    for (let i = 0; i < polls; i++) {
      if (await accessKey(accountId, keys.publicKey)) return { accountId, ...keys };
      if (i < polls - 1) await sleep(1500);
    }
    errors.push(`${host}: ${status === null ? '' : `HTTP ${status} `}${text}`);
    if (refused) throw new FaucetError(`the testnet faucet refused to create ${accountId}: ${errors.join(' | ')}`, { status, answer: text });
  }
  throw new FaucetError(`the testnet faucet did not create ${accountId}. ${errors.join(' | ')}`, { status, answer: text });
}

export const SUB_WALLET_YOCTO = 3n * YOCTO;

// A second wallet without the faucet: `<random>.<parent account id>`, created and funded by
// the parent in one transaction (CreateAccount, Transfer, AddKey with a new full-access
// key). -> { accountId, publicKey, secretKey, outcome, hash, explorerUrl, result }
//   outcome "success": the account exists with the key. "unknown": the transaction was
//   sent and may still execute; the key pair is returned so that it is not lost.
// Throws when nothing was created for certain (the error carries `result` when a
// transaction was sent).
export async function createSubWallet(parent, { amountYocto = SUB_WALLET_YOCTO } = {}) {
  const keys = await generateKeyPair();
  const accountId = `b${randomHex(4)}.${parent.accountId}`;
  if (accountId.length > 64) throw new Error(`${parent.accountId} is too long to hold a sub-account (64 characters at most)`);
  const result = await sendActions(parent, accountId, [createAccount(), transfer(BigInt(amountYocto)), addFullAccessKey(keys.publicKey)]);
  const wallet = { accountId, ...keys, hash: result.hash, explorerUrl: result.explorerUrl, result };
  if (result.ok || result.outcome === 'unknown') {
    // The key pair is returned whatever these reads say: NEAR may already sit behind it.
    for (let i = 0; i < 8; i++) {
      try {
        if (await accessKey(accountId, keys.publicKey)) return { ...wallet, outcome: 'success' };
      } catch {
        break;
      }
      await sleep(1500);
    }
    return { ...wallet, outcome: result.ok ? 'success' : 'unknown' };
  }
  const err = new Error(`${parent.accountId} did not create ${accountId}: ${result.errorMessage ?? result.outcome}`);
  err.result = result;
  throw err;
}

// An existing testnet account the visitor brings: its account id and private key in the
// near-cli form `ed25519:...`. The public key is derived from the private key and must be
// a full-access key of that account on NEAR testnet. -> { accountId, publicKey, secretKey }
// Error messages never contain the key.
export async function importTestWallet(accountIdText, secretKeyText) {
  const accountId = String(accountIdText ?? '').trim();
  const secretKey = String(secretKeyText ?? '').trim();
  if (!/^(?:(?:[a-z0-9]+[-_])*[a-z0-9]+\.)+testnet$/.test(accountId) && !/^[0-9a-f]{64}$/.test(accountId)) {
    throw new Error('Enter a NEAR testnet account id, such as name.testnet.');
  }
  if (accountId.length > 64) throw new Error('A NEAR account id has 64 characters at most.');
  let publicKey;
  try {
    publicKey = await publicKeyFromSecret(secretKey);
  } catch {
    throw new Error('That is not an ed25519 private key in the form ed25519:... as near-cli prints it.');
  }
  const key = await accessKey(accountId, publicKey);
  if (!key) throw new Error(`This key is not on ${accountId} on NEAR testnet, or the account does not exist.`);
  if (key.permission !== 'FullAccess') {
    throw new Error('This key can only call some contract methods. Buy and catch attach NEAR, so the page needs a full-access key.');
  }
  return { accountId, publicKey, secretKey };
}
