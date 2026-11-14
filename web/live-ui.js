// DOM-free logic for the "Use it on testnet" section: wallet storage format,
// the plans for each transaction, the rows of the live board, the wording of
// results, and a mock of chain.js for tests and for `?mock=1`.
//
// The page talks to the chain through web/chain.js only. Everything here takes
// that module (or the mock, which has the same shape) as an argument.

import {
  fmtTokens, fmtNear, fmtCompact, fmtDuration, fmtBps, fmtUtcDate, fmtUtcTime, nsToSeconds,
  parseDecimal, normalizeExit, exitStatus, isAccountId, EXPLORER,
} from './ui-logic.js';
import { LoudToken, LoudError, NEAR, UNIT, SEC, MIN, DAY } from './engine.js';

export const WALLET_KEY = 'loud.live.wallets.v1';
export const STORAGE_FEE = 30_000_000_000_000_000_000_000n; // 0.03 NEAR, STORAGE_MIN_YOCTO in the contract
export const GAS_DEFAULT = 100;
export const GAS_CATCH = 120;
export const SLACK_BPS = 200n; // 2% price slack on buy and catch
export const MIN_BUY = NEAR / 1000n; // the contract's floor for the NEAR that enters the pool
export const GAS_RESERVE = NEAR / 20n; // NEAR a wallet keeps back for gas
export const EXITS_PAGE = 100;
export const EXITS_MAX_PAGES = 20;

// Wallets in this browser

const isKey = (s) => typeof s === 'string' && s.length > 0 && s.length < 400;

function cleanWallet(w) {
  if (!w || typeof w !== 'object') return null;
  if (!isAccountId(w.accountId) || !isKey(w.publicKey) || !isKey(w.secretKey)) return null;
  return { accountId: w.accountId, publicKey: w.publicKey, secretKey: w.secretKey };
}

// { wallets: up to two, active: index }. Anything unreadable gives the empty store.
export function parseWallets(text) {
  const empty = { wallets: [], active: 0 };
  if (typeof text !== 'string' || text === '') return empty;
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return empty;
  }
  if (!raw || !Array.isArray(raw.wallets)) return empty;
  const wallets = raw.wallets.map(cleanWallet).filter(Boolean).slice(0, 2);
  const active = Number.isInteger(raw.active) && raw.active >= 0 && raw.active < wallets.length ? raw.active : 0;
  return { wallets, active };
}

export function serializeWallets(store) {
  return JSON.stringify({ wallets: store.wallets.map(cleanWallet).filter(Boolean).slice(0, 2), active: store.active });
}

export const walletLabel = (index) => (index === 0 ? 'Wallet A' : 'Wallet B');

// live.json

// The file the deploy job writes. null when there is no usable token in it.
export function liveConfig(json) {
  if (!json || typeof json !== 'object') return null;
  const token = json.token_account;
  if (!isAccountId(token)) return null;
  const until = typeof json.loud_until === 'string' ? Date.parse(json.loud_until) : NaN;
  return {
    token,
    tokenHref: `${EXPLORER}/address/${token}`,
    zeroKeys: json.zero_keys === true,
    loudUntilMs: Number.isFinite(until) ? until : null,
    preset: typeof json.preset === 'string' ? json.preset : '',
  };
}

// Reading the token

const DEC = /^[0-9]+$/;
const big = (v) => (typeof v === 'bigint' ? v : BigInt(v));

function bigAll(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) out[k] = typeof v === 'string' && DEC.test(v) ? BigInt(v) : v;
  return out;
}

// get_params, get_state and every page of get_exits, plus each wallet's
// balances. `chain` is chain.js or the mock.
export async function readLive(chain, token, accountIds = []) {
  const [params, state] = await Promise.all([chain.view(token, 'get_params', {}), chain.view(token, 'get_state', {})]);
  const byId = new Map();
  let capped = false;
  for (let page = 0; page < EXITS_MAX_PAGES; page++) {
    const list = await chain.view(token, 'get_exits', { from_index: page * EXITS_PAGE, limit: EXITS_PAGE });
    const rows = Array.isArray(list) ? list : [];
    for (const raw of rows) {
      const ex = normalizeExit(raw);
      byId.set(ex.id, ex);
    }
    if (rows.length < EXITS_PAGE) break;
    if (page === EXITS_MAX_PAGES - 1) capped = true;
  }
  const exits = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const accounts = await Promise.all(accountIds.map(async (id) => {
    const [acct, near, registered] = await Promise.all([
      chain.view(token, 'get_account', { account_id: id }),
      chain.accountState(id),
      chain.view(token, 'is_registered', { account_id: id }),
    ]);
    return {
      accountId: id,
      loud: big(acct.loud),
      quiet: big(acct.quiet),
      escrowed: (acct.exits || []).reduce((sum, ex) => sum + big(ex.remaining), 0n),
      near: near && near.exists ? big(near.amountYocto) : 0n,
      exists: Boolean(near && near.exists),
      registered: registered === true,
    };
  }));
  return { params: bigAll(params), state: bigAll(state), exits, capped, accounts, readAtMs: Date.now() };
}

// Chain time now: the time of the last read plus what has passed here since.
export function chainNow(live, nowMs = Date.now()) {
  return live.state.now + BigInt(Math.max(0, nowMs - live.readAtMs)) * 1_000_000n;
}

// Header facts

export function liveHeader(live, cfg) {
  const p = live.params;
  const s = live.state;
  const until = `${fmtUtcDate(p.loud_until)} ${fmtUtcTime(p.loud_until)} UTC`;
  const open = s.is_loud_window === true;
  return [
    ['Token account', cfg.token],
    ['Access keys', cfg.zeroKeys ? '0. Nobody can sign for the token account.' : 'not recorded'],
    ['Launch window', open ? `open until ${until}. Every buy until then is loud.` : `closed since ${until}. Buys are quiet now.`],
    ['Notice', fmtDuration(nsToSeconds(p.notice_ns))],
    ['Exit window', fmtDuration(nsToSeconds(p.exit_window_ns))],
    ['Cap', `${fmtTokens(p.cap_units)} LOUD (${fmtBps(p.cap_bps)} of supply) per ${fmtDuration(nsToSeconds(p.cap_window_ns))}, shared by every wallet`],
    ['Open exits', String(live.exits.length) + (live.capped ? ' or more' : '')],
    ['In the pool', `${fmtNear(s.pool_near)} NEAR paid in by buyers`],
  ];
}

// The live board

function countdown(ns) {
  const sec = Number(ns / SEC);
  if (sec < 90) return `${Math.max(1, sec)} s`;
  if (sec < 90 * 60) return `${Math.ceil(sec / 60)} min`;
  return `${Math.ceil(sec / 3600)} h`;
}

const clockUtc = (ns) => fmtUtcTime(ns).slice(0, 5); // HH:MM; the detail line carries the countdown

// One row per open exit. `me` is the active wallet's account id or ''.
// Buttons: the owner may leave once the notice is over; anyone may hush an
// expired exit; anyone but the owner may catch until it expires.
export function liveRows(exits, now, me = '', mine = []) {
  const t = big(now);
  const own = new Set(mine);
  return exits.map(normalizeExit).sort((a, b) => (a.id < b.id ? -1 : 1)).map((ex) => {
    const status = exitStatus(ex, t);
    const isMine = me !== '' && ex.owner === me;
    const whose = isMine ? 'this wallet' : own.has(ex.owner) ? 'your other wallet' : '';
    const out = ex.amount - ex.remaining;
    let detail = '';
    if (status === 'NOTICE') detail = `ready in ${countdown(ex.ready_at - t)}`;
    else if (status === 'BOARDING') detail = `${countdown(ex.expires_at - t)} left`;
    else if (status === 'EXPIRED') detail = 'locked until hush';
    if (out > 0n) detail = `${fmtCompact(out)} sold or caught${detail ? `, ${detail}` : ''}`;
    if (whose) detail = `${whose}${detail ? `, ${detail}` : ''}`;
    return {
      id: ex.id.toString(),
      account: ex.owner,
      amount: fmtCompact(ex.remaining),
      amountFull: fmtTokens(ex.remaining),
      shouted: clockUtc(ex.shouted_at),
      ready: clockUtc(ex.ready_at),
      status,
      detail,
      mine: isMine,
      remaining: ex.remaining,
      canLeave: isMine && status === 'BOARDING',
      canHush: status === 'EXPIRED' || (isMine && status !== 'EXPIRED'),
      canCatch: me !== '' && !isMine && status !== 'EXPIRED',
    };
  });
}

export function capView(live, now) {
  const s = live.state;
  const cap = live.params.cap_units;
  // Refill since the read, so the bar moves between refreshes.
  const passed = big(now) - s.now;
  const grown = s.cap_available + (cap * (passed > 0n ? passed : 0n)) / live.params.cap_window_ns;
  const avail = grown > cap ? cap : grown;
  return {
    fraction: cap > 0n ? Number((avail * 10000n) / cap) / 10000 : 0,
    text: `${fmtTokens(avail)} of ${fmtTokens(cap)} LOUD may leave now`,
  };
}

// Plans: what a button sends

const withSlackDown = (v) => v - (v * SLACK_BPS) / 10000n;
const withSlackUp = (v) => v + (v * SLACK_BPS) / 10000n + 1n;

// `nearText` is what the visitor typed. An unregistered wallet's first buy
// pays the storage fee out of the deposit, so the pool gets the rest.
export function buyPlan(nearText, account) {
  const deposit = parseDecimal(nearText, 24);
  const intoPool = account.registered ? deposit : deposit - STORAGE_FEE;
  if (intoPool < MIN_BUY) {
    return { error: account.registered ? 'Buy with at least 0.001 NEAR.' : 'A first buy pays 0.03 NEAR for storage, so attach at least 0.031 NEAR.' };
  }
  if (deposit + GAS_RESERVE > account.near) {
    return { error: `This wallet holds ${fmtNear(account.near)} NEAR. Buy with less and leave about 0.05 NEAR for gas.` };
  }
  return { deposit, intoPool, storage: account.registered ? 0n : STORAGE_FEE };
}

export const buyArgs = (plan, quotedTokens) => ({ min_tokens_out: withSlackDown(big(quotedTokens)).toString() });

export function tokenAmount(text) {
  const units = parseDecimal(text, 18);
  if (units <= 0n) throw new Error('Enter an amount of LOUD above zero.');
  return units;
}

// A quarter of what is left, or all of it when a quarter would leave the exit
// below the contract's floor (one millionth of supply) or would itself be zero.
export function quarterOf(remaining, totalSupply) {
  const dust = big(totalSupply) / 1_000_000n;
  const rem = big(remaining);
  const q = ((rem / 4n) / UNIT) * UNIT;
  if (q <= 0n || rem - q < dust) return rem;
  return q;
}

export function catchPlan(quote, account) {
  const price = big(quote.near_in);
  const deposit = withSlackUp(price);
  if (deposit + GAS_RESERVE > account.near) {
    return { error: `This catch costs about ${fmtNear(price)} NEAR and this wallet holds ${fmtNear(account.near)} NEAR. Catch a quarter, or get the second wallet.` };
  }
  return { deposit, price, fee: big(quote.fee) };
}

// Results in plain words

export const LIVE_HINTS = Object.freeze({
  E_NO_QUIET: 'Loud tokens cannot be sold directly. Shout them, wait for the notice, then leave.',
  E_NOTICE: 'The notice is still running. Wait for the countdown on the board, then press Leave again.',
  E_NOTICE_BINDING: 'The owner cannot cancel a shout. Leave when the notice is over, or hush after the exit has expired.',
  E_CAP: 'Every wallet shares this cap. Wait for it to refill and press Leave again.',
  E_SELF: 'You cannot catch your own exit. Get the second wallet and catch it from there.',
  E_DEPOSIT: 'The price moved or the deposit was too small. Press the button again to use a fresh quote.',
  E_DUST: 'Too small. A shout must be at least one millionth of supply, and a catch cannot leave less than that in the exit.',
  E_EXPIRED: 'This exit has expired. Hush returns its tokens to the owner, still loud.',
  E_NO_LOUD: 'Shout takes loud tokens only, and no more than this wallet holds.',
  E_TOO_MANY: 'A wallet can have eight exits open. Finish one, or let one expire and hush it.',
  E_POOL_EMPTY: 'The pool does not hold enough NEAR to pay for this amount.',
  E_UNREGISTERED: 'This wallet has not paid its 0.03 NEAR storage fee to the token yet.',
  E_SLIPPAGE: 'The price moved against this call. Press the button again to use a fresh quote.',
  E_NO_EXIT: 'This exit is gone: sold, caught or hushed. The board below is up to date.',
  E_AMOUNT: 'There is nothing to send or sell for that amount.',
  E_NOT_OWNER: 'Only the wallet that shouted can leave through this exit.',
});

// `kind` and `ctx` describe what was sent; `res` is what chain.call returned.
export function describeResult(kind, ctx, res) {
  const who = ctx.accountId;
  const call = `${who}  ${ctx.call}  ${res.ok ? 'ok' : 'rejected'}`;
  if (!res.ok) {
    const code = res.errorCode || '';
    const message = res.errorMessage || (code ? code : 'The transaction did not go through.');
    let hint = code ? (LIVE_HINTS[code] || '') : 'Nothing was recorded on chain for this call, or the node did not answer. Check the wallet balance and try again.';
    if (message.includes(' units')) hint = `${hint} The contract counts in units: 1 LOUD is 10^18 units.`.trim();
    return { ok: false, call, message, hint, explorerUrl: res.explorerUrl || null, hash: res.hash || null };
  }
  let message = 'Done.';
  if (kind === 'buy') {
    message = `Bought with ${fmtNear(ctx.deposit)} NEAR${ctx.storage > 0n ? ', of which 0.03 NEAR registered this wallet with the token' : ''}. The tokens are ${ctx.loud ? 'loud: the launch window is open' : 'quiet'}.`;
  } else if (kind === 'sell') {
    message = `Sold ${fmtTokens(ctx.amount)} quiet LOUD into the pool.`;
  } else if (kind === 'shout') {
    message = `Exit ${res.value ?? ''} is on the board: ${fmtTokens(ctx.amount)} LOUD locked. Leave opens after the ${fmtDuration(ctx.noticeSec)} notice. You cannot take the shout back before it expires.`.replace('Exit  is', 'The exit is');
  } else if (kind === 'leave') {
    const filled = res.value !== undefined && res.value !== null && DEC.test(String(res.value)) ? big(res.value) : null;
    message = filled === null ? 'Left through the cap.'
      : filled < ctx.remaining
        ? `Partial fill: ${fmtTokens(filled)} LOUD sold into the pool. The shared cap had no more room; ${fmtTokens(ctx.remaining - filled)} LOUD stay in the exit.`
        : `Sold ${fmtTokens(filled)} LOUD into the pool. The exit is closed.`;
  } else if (kind === 'hush') {
    message = 'The exit is closed and what was left of it is back with its owner, still loud.';
  } else if (kind === 'catch') {
    message = `Caught ${fmtTokens(ctx.amount)} LOUD from exit ${ctx.exitId} for about ${fmtNear(ctx.price)} NEAR. ${fmtNear(ctx.fee, 6)} NEAR of it, the 1% fee, stays in the pool and the rest went to the seller. The tokens are loud in this wallet. The pool sold nothing and the cap was not used.`;
  } else if (kind === 'register') {
    message = 'This wallet paid 0.03 NEAR for storage and can now hold LOUD.';
  }
  const settled = res.settled === false ? ' One of its payments has not settled yet; the explorer shows its receipts.' : '';
  return { ok: true, call, message: message + settled, hint: '', explorerUrl: res.explorerUrl || null, hash: res.hash || null };
}

export function faucetFailure(e) {
  const text = e && e.message ? e.message : String(e);
  return `The testnet faucet did not create a wallet: ${text.slice(0, 200)}. Try again in a minute.`;
}

export const NO_ED25519 = 'This browser cannot sign NEAR transactions (no Ed25519 in WebCrypto). Chrome 137, Edge 137, Firefox 129 and Safari 17 or newer can.';

// Mock of chain.js: the page's own rule engine behind the same functions, with
// a clock that follows real time. Used by tests and by `?mock=1`.

const MOCK_PARAMS = Object.freeze({
  total_supply: 1_000_000_000n * UNIT,
  creator: 'creator.testnet',
  creator_alloc_bps: 0n,
  virtual_near: 100n * NEAR,
  loud_window_ns: 7n * DAY,
  notice_ns: 1n * MIN,
  exit_window_ns: 30n * MIN,
  cap_bps: 50n,
  cap_window_ns: 10n * MIN,
});

export const MOCK_TOKEN = 't.loud-mock.testnet';

const toJson = (v) => JSON.parse(JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x)));

export function createMockChain({ startMs = 1_800_000_000_000, nowMs = () => Date.now(), faucetFails = false } = {}) {
  const t0 = BigInt(startMs) * 1_000_000n;
  const real0 = nowMs();
  let skipped = 0n;
  const now = () => t0 + BigInt(Math.max(0, nowMs() - real0)) * 1_000_000n + skipped;
  const token = new LoudToken({ ...MOCK_PARAMS }, t0);
  const near = new Map(); // account -> yoctoNEAR
  const registered = new Set([MOCK_PARAMS.creator]);
  let seq = 0;
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const fakeHash = () => {
    seq += 1;
    let s = '';
    let x = BigInt(seq) * 2654435761n + 99991n;
    for (let i = 0; i < 44; i++) {
      s += B58[Number(x % 58n)];
      x = x / 58n + BigInt(i + 7) * 1000003n;
    }
    return s;
  };
  const txUrl = (hash) => `${EXPLORER}/txns/${hash}`;
  const accountUrl = (id) => `${EXPLORER}/address/${id}`;
  const GAS = NEAR / 1000n;

  async function createTestWallet({ prefix = 'loud-try' } = {}) {
    if (faucetFails) throw new Error('faucet answered HTTP 429');
    seq += 1;
    const accountId = `${prefix}-${seq.toString(36)}${(seq * 7919).toString(36)}.testnet`;
    near.set(accountId, 10n * NEAR);
    return { accountId, publicKey: `ed25519:mock${seq}`, secretKey: `mock-secret-${seq}` };
  }

  async function view(contractId, method, args = {}) {
    if (contractId !== MOCK_TOKEN) throw new Error(`no such contract ${contractId}`);
    const t = now();
    if (method === 'get_params') return toJson(token.getParams());
    if (method === 'get_state') return toJson({ ...token.getState(t), owed_total: 0n });
    if (method === 'get_exits') return toJson(token.getExits(args.from_index ?? 0, args.limit ?? 100));
    if (method === 'get_account') return toJson(token.getAccount(args.account_id));
    if (method === 'is_registered') return registered.has(args.account_id);
    if (method === 'quote_buy') return token.quoteBuy(BigInt(args.near)).toString();
    if (method === 'quote_catch') {
      return toJson(token.quoteCatch(BigInt(args.exit_id), args.amount === undefined || args.amount === null ? null : BigInt(args.amount)));
    }
    throw new Error(`mock has no view ${method}`);
  }

  async function accountState(accountId) {
    return near.has(accountId) ? { exists: true, amountYocto: near.get(accountId).toString() } : { exists: false, amountYocto: '0' };
  }

  async function call(wallet, contractId, method, args = {}, { depositYocto = '0' } = {}) {
    const who = wallet.accountId;
    const hash = fakeHash();
    const out = { ok: false, hash, value: null, errorCode: null, errorMessage: null, logs: [], explorerUrl: txUrl(hash), settled: true };
    const deposit = BigInt(depositYocto);
    const bal = near.get(who) ?? 0n;
    if (contractId !== MOCK_TOKEN || deposit + GAS > bal) {
      return { ...out, hash: null, explorerUrl: null, errorMessage: 'the account does not have enough NEAR for this transaction' };
    }
    const t = now();
    let credit = 0n; // NEAR that comes back to the caller
    try {
      const reg = () => {
        if (!registered.has(who)) fail('E_UNREGISTERED', `${who} is not registered; call storage_deposit for it first`);
      };
      if (method === 'storage_deposit') {
        if (registered.has(who)) credit = deposit;
        else if (deposit < STORAGE_FEE) fail('E_STORAGE', 'attach at least 0.03 NEAR to register an account');
        else {
          registered.add(who);
          credit = deposit - STORAGE_FEE;
        }
      } else if (method === 'buy') {
        const storage = registered.has(who) ? 0n : STORAGE_FEE;
        if (deposit - storage < MIN_BUY) fail('E_DEPOSIT', 'attach at least 0.001 NEAR above the storage payment');
        out.value = token.buy(who, deposit - storage, BigInt(args.min_tokens_out), t).toString();
        registered.add(who);
      } else if (method === 'sell') {
        token.sell(who, BigInt(args.amount), BigInt(args.min_near_out ?? 0), t);
        credit = token.last_near_out;
        out.value = credit.toString();
      } else if (method === 'shout') {
        out.value = token.shout(who, BigInt(args.amount), t).toString();
      } else if (method === 'leave') {
        out.value = token.leave(who, BigInt(args.exit_id), BigInt(args.min_near_out ?? 0), t).toString();
        credit = token.last_near_out;
      } else if (method === 'hush') {
        token.hush(who, BigInt(args.exit_id), t);
      } else if (method === 'catch') {
        const ex = token.getExits(0, 100).find((e) => e.id === BigInt(args.exit_id));
        if (ex && ex.owner !== who) reg();
        out.value = token.catch(who, BigInt(args.exit_id), args.amount === undefined || args.amount === null ? null : BigInt(args.amount), deposit, t).toString();
        credit = token.last_catch.refund;
        near.set(ex.owner, (near.get(ex.owner) ?? 0n) + token.last_catch.to_owner);
      } else {
        fail('E_METHOD', `mock has no method ${method}`);
      }
      out.ok = true;
      near.set(who, (near.get(who) ?? 0n) - deposit - GAS + credit);
    } catch (e) {
      near.set(who, bal - GAS);
      if (e instanceof LoudError) {
        out.errorCode = e.code;
        out.errorMessage = e.message;
      } else {
        out.errorMessage = e && e.message ? e.message : String(e);
      }
    }
    return out;
  }

  function fail(code, detail) {
    throw new LoudError(code, detail);
  }

  return {
    NETWORK: 'testnet (mock)',
    RPC_URLS: [],
    FAUCET_URLS: [],
    EXPLORER,
    createTestWallet,
    exportWallet: (w) => ({ ...w }),
    importWallet: (o) => cleanWallet(o),
    view,
    accountState,
    call,
    txUrl,
    accountUrl,
    // Mock only: move the clock.
    advance(ns) {
      skipped += BigInt(ns);
    },
    isMock: true,
  };
}

export const mockLiveJson = () => ({
  status: 'ok',
  preset: 'live',
  token_account: MOCK_TOKEN,
  zero_keys: true,
  loud_until: new Date(1_800_000_000_000 + 7 * 86400 * 1000).toISOString(),
});
