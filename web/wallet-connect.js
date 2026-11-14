// Connecting a NEAR wallet app on testnet (beta).
//
// The connector is the NEAR ecosystem's @hot-labs/near-connect, loaded only when a visitor
// presses the connect button, from a URL pinned to one commit, and run only when its
// SHA-384 matches the value below. Once running it fetches its list of wallets and each
// wallet's own script from its own URLs, which are not pinned; those scripts run in
// sandboxed iframes without access to this page's storage.
//
// Every transaction of a connected wallet is read back from NEAR testnet by its hash
// (chain.txStatus), so the result has the same shape and the same parsing as a test
// wallet's chain.call. The page never sends a wallet's transaction again.

export const CONNECTOR = Object.freeze({
  name: '@hot-labs/near-connect',
  version: '0.12.0',
  commit: 'e71894f7e69d9ea66a4d185b1297ac1d34f16b2a',
  url: 'https://cdn.jsdelivr.net/gh/azbang/near-connect@e71894f7e69d9ea66a4d185b1297ac1d34f16b2a/cdn/hot-connect.es.js',
  sha384: 'rr+Ukc3LzZpfbx8BjIqPC9GqXPOabYKEVi9rpNKoYTyCoqzWyY+W3YMxkbhU8Po6',
});

// Set only after a wallet was connected here; without it the connector is never loaded.
export const CONNECTED_KEY = 'loud.live.connected.v1';
// How long the page waits for the wallet before it reports "unknown".
export const WALLET_WAIT_MS = 5 * 60_000;
export const CONNECTOR_OPTIONS = Object.freeze({ network: 'testnet', features: { signAndSendTransaction: true, testnet: true } });

const TGAS = 10n ** 12n;
const HASH_RE = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

const text = (e) => (e && e.message ? e.message : String(e));

export async function sha384Base64(bytes, subtle = globalThis.crypto.subtle) {
  const digest = new Uint8Array(await subtle.digest('SHA-384', bytes));
  let s = '';
  for (const b of digest) s += String.fromCharCode(b);
  return btoa(s);
}

// -> the connector module ({ NearConnector, ... }). Throws before running anything when
// the download fails or does not match the pinned checksum.
export async function loadConnector({
  fetchImpl = globalThis.fetch,
  importer = (u) => import(/* @vite-ignore */ u),
  subtle = globalThis.crypto.subtle,
  makeUrl = (bytes) => URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' })),
  revoke = (u) => URL.revokeObjectURL(u),
} = {}) {
  let res;
  try {
    res = await fetchImpl(CONNECTOR.url, { credentials: 'omit' });
  } catch (e) {
    throw new Error(`the wallet connector could not be downloaded (${text(e)})`);
  }
  if (!res || !res.ok) throw new Error(`the wallet connector could not be downloaded (HTTP ${res ? res.status : 'no answer'})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if ((await sha384Base64(bytes, subtle)) !== CONNECTOR.sha384) {
    throw new Error('the downloaded wallet connector does not match its pinned checksum, so it was not run');
  }
  const url = makeUrl(bytes);
  try {
    const mod = await importer(url);
    if (!mod || typeof mod.NearConnector !== 'function') throw new Error('the wallet connector has no NearConnector');
    return mod;
  } finally {
    revoke(url);
  }
}

// A NEAR testnet account id, or an implicit account (which exists on either network, so
// the chain decides).
export function isTestnetAccountId(id) {
  const s = String(id ?? '');
  return /^([a-z0-9]+[-_])*[a-z0-9]+(\.([a-z0-9]+[-_])*[a-z0-9]+)*\.testnet$/.test(s)
    || /^[0-9a-f]{64}$/.test(s) || /^0x[0-9a-f]{40}$/.test(s);
}

// The wallet's words for "the user said no". Only these count as "nothing was sent";
// every other error is "unknown".
export function isRejection(e) {
  return /\buser (has )?(rejected|denied|declined|cancel+ed|closed)|(rejected|denied|declined|cancel+ed) by (the )?user|request (was )?(rejected|denied|cancel+ed)/i.test(text(e));
}

export function hashOf(out) {
  if (typeof out === 'string') return HASH_RE.test(out) ? out : null;
  if (Array.isArray(out)) return out.length === 1 ? hashOf(out[0]) : null;
  if (!out || typeof out !== 'object') return null;
  for (const h of [out.transaction?.hash, out.transaction_outcome?.id, out.transactionHash, out.txHash, out.hash, out.context?.transactionHash]) {
    if (typeof h === 'string' && HASH_RE.test(h)) return h;
  }
  return null;
}

// The connected account, checked on NEAR testnet.
// -> { kind: 'connected', accountId, walletName, walletId, wallet }
export async function connectedAccount(wallet, chain) {
  const accounts = await wallet.getAccounts({ network: 'testnet' });
  const id = Array.isArray(accounts) && accounts[0] ? String(accounts[0].accountId ?? '') : '';
  if (!id) throw new Error('The wallet returned no account.');
  if (!isTestnetAccountId(id)) {
    throw new Error(`The wallet is signed in to ${id}, which is not a NEAR testnet account. Switch the wallet to testnet and connect again.`);
  }
  let st;
  try {
    st = await chain.accountState(id);
  } catch (e) {
    throw new Error(`Could not check ${id} on NEAR testnet (${text(e)}). Try again.`);
  }
  if (!st || !st.exists) throw new Error(`${id} does not exist on NEAR testnet. Switch the wallet to testnet and connect again.`);
  const manifest = wallet.manifest || {};
  return { kind: 'connected', accountId: id, walletName: String(manifest.name || 'the wallet'), walletId: String(manifest.id || ''), wallet };
}

export function connectFailure(e) {
  if (isRejection(e)) return 'No wallet was connected: the wallet list or the wallet was closed.';
  const why = text(e).trim().replace(/\.$/, '');
  return `No wallet was connected. ${why.charAt(0).toUpperCase()}${why.slice(1)}. Test wallets work as before.`;
}

// Waits for `promise`, a stop request or the time limit.
// -> { kind: 'value', value } | { kind: 'error', error } | { kind: 'stopped' } | { kind: 'timeout' }
export function settleOrStop(start, { stop = null, waitMs = WALLET_WAIT_MS } = {}) {
  let timer = null;
  const racers = [
    Promise.resolve().then(start).then((value) => ({ kind: 'value', value }), (error) => ({ kind: 'error', error })),
    new Promise((r) => {
      timer = setTimeout(() => r({ kind: 'timeout' }), waitMs);
    }),
  ];
  if (stop) racers.push(stop.then(() => ({ kind: 'stopped' })));
  return Promise.race(racers).finally(() => clearTimeout(timer));
}

const emptyResult = {
  ok: false, outcome: 'unknown', hash: null, value: null, errorCode: null, errorMessage: null, logs: [], events: [],
  explorerUrl: null, settled: false, settlement: null, payoutsFailed: [], refusedHash: null, signedHashes: [],
};

// One function call through a connected wallet. Same result shape as chain.call, plus
// `via: 'wallet'`, `walletName`, and `rejected: true` when the wallet says the user said no.
// Never throws: once the wallet was asked, an error is "rejected" or "unknown".
export async function callConnected(conn, receiverId, method, args = {}, { gasTgas = 100, depositYocto = '0' } = {}, { chain, stop = null, waitMs = WALLET_WAIT_MS } = {}) {
  const base = { ...emptyResult, via: 'wallet', walletName: conn.walletName };
  const params = {
    network: 'testnet',
    signerId: conn.accountId,
    receiverId,
    actions: [{ type: 'FunctionCall', params: { methodName: method, args, gas: (BigInt(gasTgas) * TGAS).toString(), deposit: BigInt(depositYocto).toString() } }],
  };
  const got = await settleOrStop(() => conn.wallet.signAndSendTransaction(params), { stop, waitMs });

  if (got.kind === 'stopped' || got.kind === 'timeout') {
    return {
      ...base,
      errorMessage: got.kind === 'stopped'
        ? 'The page stopped waiting for the wallet. If you approved the request there, the transaction may still execute.'
        : `The wallet did not answer within ${Math.round(waitMs / 60000)} min. If you approved the request there, the transaction may still execute.`,
    };
  }
  if (got.kind === 'error') {
    const e = got.error;
    if (isRejection(e)) {
      return { ...base, outcome: 'invalid', rejected: true, errorMessage: `The wallet reports that the request was rejected (${text(e).slice(0, 160)}). Nothing was signed or sent.` };
    }
    const h = hashOf(e);
    if (h) return settle(h);
    return { ...base, errorCode: null, errorMessage: `The wallet returned an error and no transaction hash: ${text(e).slice(0, 300)}` };
  }
  const h = hashOf(got.value);
  if (!h) {
    return { ...base, errorMessage: 'The wallet returned no transaction hash, so the page cannot tell whether a transaction was sent.' };
  }
  return settle(h);

  async function settle(hash) {
    let r = null;
    try {
      r = await chain.txStatus(hash, conn.accountId);
    } catch {
      r = null;
    }
    const url = chain.txUrl(hash);
    if (!r) {
      return { ...base, hash, explorerUrl: url, signedHashes: [hash], errorMessage: 'The wallet sent the transaction, but NEAR testnet did not return its final outcome in time. It may still execute.' };
    }
    return { ...r, hash, explorerUrl: url, refusedHash: null, signedHashes: [hash], via: 'wallet', walletName: conn.walletName };
  }
}

// Test wallets sign in the page; a connected wallet signs in the wallet app.
export function callWith(chain, w, contractId, method, args, opts, extra = {}) {
  if (w && w.kind === 'connected') return callConnected(w, contractId, method, args, opts, { chain, ...extra });
  return chain.call(w, contractId, method, args, opts);
}

// ---------------------------------------------------------------------------------------
// A stand-in for the connector module, for ?mock=1 and tests. `control.next` picks what
// the wallet does with the next transaction: 'approve', 'reject', 'error', 'nothing' or
// 'hang'. `control.connect`: 'approve', 'reject' or 'mainnet'.
// ---------------------------------------------------------------------------------------

export function createFakeConnectorModule(mock, { accountId = 'visitor-wallet.testnet', walletName = 'Mock wallet', fundYocto = 10n * 10n ** 24n } = {}) {
  const control = { next: 'approve', connect: 'approve', sent: [], funded: false };
  const manifest = { id: 'mock-wallet', name: walletName };
  let signedIn = false;
  const signedInAs = () => (control.connect === 'mainnet' ? 'visitor.near' : accountId);
  const wallet = {
    manifest,
    async getAccounts() {
      return signedIn ? [{ accountId: signedInAs() }] : [];
    },
    async signOut() {
      signedIn = false;
    },
    async signAndSendTransaction(p) {
      control.sent.push(p);
      const mode = control.next;
      control.next = 'approve';
      if (mode === 'reject') throw new Error('User rejected the request');
      if (mode === 'error') throw new Error('Wallet connection lost');
      if (mode === 'hang') return new Promise(() => {});
      const a = p.actions[0].params;
      const r = await mock.call({ accountId: p.signerId }, p.receiverId, a.methodName, a.args, { depositYocto: a.deposit });
      if (mode === 'nothing') return undefined;
      if (!r.hash) throw new Error(`Transaction refused: ${r.errorMessage}`);
      return { transaction: { hash: r.hash }, status: r.ok ? { SuccessValue: '' } : { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: r.errorMessage } } } } } };
    },
  };
  class NearConnector {
    constructor(options = {}) {
      this.options = options;
      this.handlers = new Map();
    }

    on(name, fn) {
      if (!this.handlers.has(name)) this.handlers.set(name, []);
      this.handlers.get(name).push(fn);
    }

    emit(name, payload) {
      for (const fn of this.handlers.get(name) || []) fn(payload);
    }

    async connect() {
      if (control.connect === 'reject') throw new Error('User rejected');
      if (!control.funded) {
        mock.fundAccount(accountId, fundYocto);
        control.funded = true;
      }
      signedIn = true;
      this.emit('wallet:signIn', { wallet, accounts: [{ accountId: signedInAs() }], success: true, source: 'signIn' });
      return wallet;
    }

    async wallet() {
      if (!signedIn) throw new Error('No accounts found');
      return wallet;
    }

    async disconnect() {
      signedIn = false;
      this.emit('wallet:signOut', { success: true });
    }
  }
  return { NearConnector, control };
}
