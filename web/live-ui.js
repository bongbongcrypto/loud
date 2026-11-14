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
export const EXITS_MAX_PAGES = 100; // 10,000 exits; a wallet can hold 8 open

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

// The test wallets kept in this browser, under WALLET_KEY in the format above (at most two,
// with the active index). Shared by every page of the site. A blocked storage throws.
export function loadWallets(storage = globalThis.localStorage) {
  return parseWallets(storage.getItem(WALLET_KEY));
}

export function saveWallets(store, storage = globalThis.localStorage) {
  storage.setItem(WALLET_KEY, serializeWallets(store));
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

// get_state, get_params and every page of get_exits, plus each wallet's
// balances. `chain` is chain.js or the mock. When the chain can read at a given
// block (chain.viewAt), every view of the token is read at the block of get_state,
// so the pages of get_exits describe one instant; if that fails, they are read
// again at the last final block and `block.pinned` is false.
export async function readLive(chain, token, accountIds = []) {
  let state;
  let height = null;
  if (typeof chain.viewAt === 'function') {
    const st = await chain.viewAt(token, 'get_state', {});
    state = st.value;
    height = st.blockHeight;
  } else {
    state = await chain.view(token, 'get_state', {});
  }
  const latest = (method, args) => chain.view(token, method, args);
  let token_ = null;
  if (height !== null) {
    try {
      token_ = await readParamsAndExits((method, args) => chain.viewAt(token, method, args, height).then((r) => r.value));
    } catch {
      token_ = null;
    }
  }
  const pinned = token_ !== null;
  if (!token_) token_ = await readParamsAndExits(latest);
  const accounts = await Promise.all(accountIds.map(async (id) => {
    const [acct, near, registered, owed] = await Promise.all([
      chain.view(token, 'get_account', { account_id: id }),
      chain.accountState(id),
      chain.view(token, 'is_registered', { account_id: id }),
      chain.view(token, 'get_owed', { account_id: id }),
    ]);
    return {
      accountId: id,
      loud: big(acct.loud),
      quiet: big(acct.quiet),
      escrowed: (acct.exits || []).reduce((sum, ex) => sum + big(ex.remaining), 0n),
      near: near && near.exists ? big(near.amountYocto) : 0n,
      exists: Boolean(near && near.exists),
      registered: registered === true,
      owed: typeof owed === 'string' && DEC.test(owed) ? BigInt(owed) : 0n,
    };
  }));
  return {
    params: bigAll(token_.params), state: bigAll(state), exits: token_.exits, capped: token_.capped, accounts,
    block: { pinned, height }, readAtMs: Date.now(),
  };
}

async function readParamsAndExits(read) {
  const params = await read('get_params', {});
  const byId = new Map();
  let capped = false;
  for (let page = 0; page < EXITS_MAX_PAGES; page++) {
    const list = await read('get_exits', { from_index: page * EXITS_PAGE, limit: EXITS_PAGE });
    const rows = Array.isArray(list) ? list : [];
    for (const raw of rows) {
      const ex = normalizeExit(raw);
      byId.set(ex.id, ex);
    }
    if (rows.length < EXITS_PAGE) break;
    if (page === EXITS_MAX_PAGES - 1) capped = true;
  }
  const exits = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { params, exits, capped };
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
    ['Open exits', openExitsText(live)],
    ['In the pool', `${fmtNear(s.pool_near)} NEAR paid in by buyers`],
  ];
}

function openExitsText(live) {
  const n = live.exits.length;
  const open = Number(live.state.open_exits);
  if (Number.isFinite(open) && open > n) return `${open} (the board shows ${n})`;
  return String(Number.isFinite(open) ? open : n);
}

const clockOf = (ms) => new Date(ms).toISOString().slice(11, 19);

// The line under the live board: how many exits it shows, how they were read,
// and, after a failed read, that the board is an older read.
export function boardNote(live, readError = '', source = 'NEAR testnet') {
  if (!live) return '';
  if (readError) {
    return `Could not read the token just now (${readError}). The board below is the read of ${clockOf(live.readAtMs)} UTC and may be out of date. The page tries again in 10 s.`;
  }
  const n = live.exits.length;
  const open = Number(live.state.open_exits);
  const shown = Number.isFinite(open) && open > n
    ? `The board shows ${n} of the ${open} open exits on the token`
    : `${n === 1 ? '1 open exit' : `${n} open exits`} on the token, from every visitor`;
  const how = live.block && live.block.pinned
    ? `, read page by page (${EXITS_PAGE} a page) at block ${live.block.height}`
    : `, read page by page (${EXITS_PAGE} a page)`;
  return `${shown}${how} from ${source} at ${clockOf(live.readAtMs)} UTC. The list may lag the chain by a few seconds. Times are UTC. The board reads again every 10 s.`;
}

// The demo-setting note, from the chain: it stops saying that buys are loud once
// the launch window has closed.
export function demoNote(live) {
  const p = live.params;
  const until = `${fmtUtcDate(p.loud_until)} ${fmtUtcTime(p.loud_until)} UTC`;
  const window = live.state.is_loud_window === true
    ? `Its launch window is open until ${until}, so every buy until then is loud and every visitor can shout, leave and catch. Nobody holds quiet tokens on it yet.`
    : `Its launch window closed at ${until}. Buys are quiet now and sell at once with Sell; tokens bought before then stay loud and still have to shout.`;
  return `This token runs a demo setting. ${window} The notice is ${fmtDuration(nsToSeconds(p.notice_ns))} here, against 30 min in the standard preset.`;
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
  E_DUST: 'Too small. A shout must be at least one millionth of supply (1,000 LOUD on this token), unless it is the wallet\'s whole loud balance and the wallet has no other open exit. A catch cannot leave less than that in the exit.',
  E_EXPIRED: 'This exit has expired. Hush returns its tokens to the owner, still loud.',
  E_NO_LOUD: 'Shout takes loud tokens only, and no more than this wallet holds.',
  E_TOO_MANY: 'A wallet can have eight exits open. Finish one, or let one expire and hush it.',
  E_POOL_EMPTY: 'The pool does not hold enough NEAR to pay for this amount.',
  E_UNREGISTERED: 'This wallet has not paid its 0.03 NEAR storage fee to the token yet.',
  E_SLIPPAGE: 'The price moved against this call. Press the button again to use a fresh quote.',
  E_NO_EXIT: 'This exit is no longer open: it was sold, caught or hushed. The board is read again after this call.',
  E_AMOUNT: 'There is nothing to send or sell for that amount.',
  E_NOT_OWNER: 'Only the wallet that shouted can leave through this exit.',
  E_NOTHING_OWED: 'No failed payout is recorded for this wallet.',
});

const loudEvent = (res, name) => {
  const ev = (Array.isArray(res.events) ? res.events : []).find((e) => e && e.standard === 'loud' && e.event === name);
  return ev && ev.data && typeof ev.data === 'object' ? ev.data : null;
};
const units = (v) => (v !== undefined && v !== null && DEC.test(String(v)) ? BigInt(v) : null);

// Why a leave filled only part of the exit, from a get_state read after the call
// (`after`: { capAvailable, capUnits, poolNear, quoteForRest }, where quoteForRest is
// quote_sell of what is left, up to the cap room). 'cap' when the shared cap is
// (near) empty: at most 2% of one cap, about 12 s of refill on the 10 min window.
// 'pool' when the pool holds less NEAR than the rest would fetch. null when unknown.
export function partialReason(after) {
  if (!after) return null;
  const capUnits = units(after.capUnits);
  const capAvailable = units(after.capAvailable);
  if (capUnits === null || capAvailable === null) return null;
  if (capAvailable * 100n <= capUnits * 2n) return 'cap';
  const quote = units(after.quoteForRest);
  const pool = units(after.poolNear);
  if (quote !== null && pool !== null && quote > pool) return 'pool';
  return null;
}

// Payouts of a successful call: settled, recorded as owed (claim), or not confirmed.
// The sentence never says NEAR arrived unless every receipt succeeded.
function settlementText(res, who) {
  const state = res.settlement ?? (res.settled === false ? 'unconfirmed' : 'settled');
  if (state === 'payout_failed') {
    return (res.payoutsFailed || []).map((p) => {
      const mine = p.account === who;
      return ` A payout of ${fmtNear(units(p.amount) ?? 0n, 6)} NEAR to ${mine ? 'this wallet' : p.account} came back. The token recorded it as owed; ${mine ? 'press Claim to get it' : 'that account can get it with claim'}.`;
    }).join('');
  }
  if (state === 'unconfirmed') {
    return ' Not every receipt of this transaction succeeded, so a payment in it may not have arrived. The explorer shows its receipts.';
  }
  return '';
}

// `kind` and `ctx` describe what was sent; `res` is what chain.call returned.
// Numbers in a success line come from the contract's events in the receipts, not
// from the quote made before sending; without the event the line has no numbers.
export function describeResult(kind, ctx, res) {
  const who = ctx.accountId;
  const link = { explorerUrl: res.explorerUrl || null, hash: res.hash || null };
  if (res.via === 'wallet' && res.rejected) {
    return { ok: false, call: `${who}  ${ctx.call}  rejected in the wallet`, message: res.errorMessage || 'The request was rejected in the wallet. Nothing was signed or sent.', hint: '', ...link };
  }
  if (res.outcome === 'unknown') {
    if (res.via === 'wallet') {
      return {
        ok: false,
        unknown: true,
        call: `${who}  ${ctx.call}  ${res.hash ? 'sent, not confirmed' : 'no answer from the wallet'}`,
        message: res.errorMessage || 'The wallet did not return a final outcome.',
        hint: res.hash
          ? 'Open it in the explorer before you press the button again: pressing again sends a second transaction.'
          : `Look at the account's recent transactions in ${res.walletName || 'the wallet'} or the explorer before you press the button again: pressing again may send a second transaction.`,
        ...link,
      };
    }
    return {
      ok: false,
      unknown: true,
      call: `${who}  ${ctx.call}  sent, not confirmed`,
      message: 'The transaction was sent, but NEAR testnet did not confirm it in time. It may still execute.',
      hint: 'Open it in the explorer before you press the button again: pressing again sends a second transaction.',
      ...link,
    };
  }
  const call = `${who}  ${ctx.call}  ${res.ok ? 'ok' : 'rejected'}`;
  if (!res.ok) {
    const code = res.errorCode || '';
    const message = res.errorMessage || (code ? code : 'The transaction did not go through.');
    let hint = code ? (LIVE_HINTS[code] || '')
      : res.outcome === 'failure' ? 'The transaction ran and failed. The explorer shows why.'
        : 'A node refused this transaction before it ran, so nothing changed on chain. Check the wallet balance and try again.';
    if (message.includes(' units')) hint = `${hint} The contract counts in units: 1 LOUD is 10^18 units.`.trim();
    return { ok: false, call, message, hint, ...link };
  }
  let message = 'Done.';
  if (kind === 'buy') {
    const ev = loudEvent(res, 'buy');
    const out = ev ? units(ev.tokens_out) : null;
    if (out !== null) {
      const storage = units(ev.storage_paid) ?? 0n;
      const tag = ev.loud === true ? ' The tokens are loud: they were bought in the launch window.'
        : ev.loud === false ? ' The tokens are quiet: the launch window has closed, so they sell at once with Sell.' : '';
      message = `Bought ${fmtTokens(out)} LOUD with ${fmtNear(ctx.deposit)} NEAR${storage > 0n ? `, of which ${fmtNear(storage, 2)} NEAR registered this wallet with the token` : ''}.${tag}`;
    } else {
      message = `The buy with ${fmtNear(ctx.deposit)} NEAR went through. The explorer shows how many tokens arrived and whether they are loud.`;
    }
  } else if (kind === 'sell') {
    const ev = loudEvent(res, 'sell');
    const near = ev ? units(ev.near_out) : null;
    message = near !== null && units(ev.tokens_in) !== null
      ? `Sold ${fmtTokens(units(ev.tokens_in))} quiet LOUD into the pool for ${fmtNear(near)} NEAR.`
      : `Sold ${fmtTokens(ctx.amount)} quiet LOUD into the pool.`;
  } else if (kind === 'shout') {
    const ev = loudEvent(res, 'shout');
    const amount = ev ? units(ev.amount) : null;
    const id = ev && ev.id !== undefined ? String(ev.id) : res.value !== null && res.value !== undefined ? String(res.value) : '';
    message = `${id ? `Exit ${id} is` : 'The exit is'} on the board: ${fmtTokens(amount ?? ctx.amount)} LOUD locked. Leave opens after the ${fmtDuration(ctx.noticeSec)} notice. You cannot take the shout back before it expires.`;
  } else if (kind === 'leave') {
    const ev = loudEvent(res, 'leave');
    const filled = ev ? units(ev.filled) : null;
    const rest = ev ? units(ev.remaining) : null;
    const near = ev ? units(ev.near_out) : null;
    if (filled === null || rest === null || near === null) {
      message = 'The leave went through. The explorer shows how much was sold.';
    } else if (rest === 0n) {
      message = `Sold ${fmtTokens(filled)} LOUD into the pool for ${fmtNear(near)} NEAR. The exit is closed.`;
    } else {
      const why = partialReason(ctx.after);
      const reason = why === 'cap' ? ' The shared cap had no more room; press Leave again when it has refilled.'
        : why === 'pool' ? ' The pool held too little NEAR to pay for more.' : '';
      message = `Partial fill: ${fmtTokens(filled)} LOUD sold into the pool for ${fmtNear(near)} NEAR; ${fmtTokens(rest)} LOUD stay in the exit.${reason}`;
    }
  } else if (kind === 'hush') {
    const ev = loudEvent(res, 'hush');
    const amount = ev ? units(ev.amount) : null;
    message = amount !== null
      ? `The exit is closed and its ${fmtTokens(amount)} LOUD are back with ${ev.account === who ? 'this wallet' : ev.account}, still loud.`
      : 'The exit is closed and what was left of it is back with its owner, still loud.';
  } else if (kind === 'catch') {
    const ev = loudEvent(res, 'catch');
    const amount = ev ? units(ev.amount) : null;
    const rest = ev ? units(ev.remaining) : null;
    const paid = ev ? units(ev.near_paid) : null;
    const fee = ev ? units(ev.fee) : null;
    const tail = 'The tokens are loud in this wallet. The pool sold nothing and the cap was not used.';
    if (amount === null || rest === null || paid === null || fee === null) {
      message = `Caught LOUD from exit ${ctx.exitId}. The explorer shows the amount and the price. ${tail}`;
    } else {
      const settled = (res.settlement ?? (res.settled === false ? 'unconfirmed' : 'settled')) === 'settled';
      message = `Caught ${fmtTokens(amount)} LOUD from exit ${ctx.exitId} for ${fmtNear(paid)} NEAR. ${fmtNear(fee, 6)} NEAR of it, the 1% fee, stays in the pool, and ${fmtNear(paid - fee)} NEAR ${settled ? 'went' : 'is due'} to the seller. ${rest === 0n ? 'The exit is closed.' : `${fmtTokens(rest)} LOUD are left in the exit.`} ${tail}`;
    }
  } else if (kind === 'claim') {
    const ev = loudEvent(res, 'claim');
    const amount = ev ? units(ev.amount) : null;
    message = amount !== null
      ? `Claimed ${fmtNear(amount, 6)} NEAR that an earlier payout could not deliver. It is paid out again now.`
      : 'The claim went through. The explorer shows the amount.';
  } else if (kind === 'register') {
    message = 'This wallet paid 0.03 NEAR for storage and can now hold LOUD.';
  }
  return { ok: true, call, message: message + settlementText(res, who), hint: '', ...link };
}

export const FAUCET_LIMIT = 'The public testnet faucet limits how many accounts one network address can create; try again later or from another network. The simulator below works without it.';

export function faucetFailure(e) {
  const text = e && e.message ? e.message : String(e);
  return `The testnet faucet did not create a wallet: ${text.slice(0, 300)}. ${FAUCET_LIMIT}`;
}

// The second wallet: made from wallet A (a sub-account funded with 3 of its test NEAR)
// when A can pay for it and its id leaves room for a sub-account; the faucet otherwise.
export const SUB_WALLET_NEAR = 3n * NEAR;
export function secondWalletRoute(walletA, accountA) {
  if (!walletA || !accountA || !accountA.exists) return 'faucet';
  if (`b00000000.${walletA.accountId}`.length > 64) return 'faucet';
  return accountA.near >= SUB_WALLET_NEAR + GAS_RESERVE ? 'sub' : 'faucet';
}

export const NO_ED25519 = 'This browser cannot sign NEAR transactions (no Ed25519 in WebCrypto). Chrome 137, Edge 137, Firefox 129 and Safari 17 or newer can.';

// Mock of chain.js: the page's own rule engine behind the same functions, with
// a clock that follows real time. Used by tests and by `?mock=1`. Nothing in it
// touches a chain: its hashes are invented, so it gives no explorer links.
// `payoutFails`: every NEAR payout to the exit owner or seller comes back and is
// recorded as owed, as a failed transfer receipt does on chain.

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
export const MOCK_BANNER = 'MOCK: no chain, invented transactions';

const toJson = (v) => JSON.parse(JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x)));

export function createMockChain({ startMs = 1_800_000_000_000, nowMs = () => Date.now(), faucetFails = false, payoutFails = false } = {}) {
  const t0 = BigInt(startMs) * 1_000_000n;
  const real0 = nowMs();
  let skipped = 0n;
  const now = () => t0 + BigInt(Math.max(0, nowMs() - real0)) * 1_000_000n + skipped;
  const token = new LoudToken({ ...MOCK_PARAMS }, t0);
  const near = new Map(); // account -> yoctoNEAR
  const owed = new Map(); // account -> yoctoNEAR of failed payouts
  const registered = new Set([MOCK_PARAMS.creator]);
  const results = new Map(); // hash -> call result, for txStatus
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
  const GAS = NEAR / 1000n;

  async function createTestWallet({ prefix = 'loud-try' } = {}) {
    if (faucetFails) throw new Error('the testnet faucet refused to create the account: faucet.example: HTTP 429 {"error":"Too many requests, retry in 12 hours"}');
    seq += 1;
    const accountId = `${prefix}-${seq.toString(36)}${(seq * 7919).toString(36)}.testnet`;
    near.set(accountId, 10n * NEAR);
    return { accountId, publicKey: `ed25519:mock${seq}`, secretKey: `mock-secret-${seq}` };
  }

  async function createSubWallet(parent, { amountYocto = 3n * NEAR } = {}) {
    const amount = BigInt(amountYocto);
    const bal = near.get(parent.accountId) ?? 0n;
    if (amount + GAS > bal) {
      const err = new Error(`${parent.accountId} does not have enough NEAR for this transaction`);
      err.result = { ok: false, outcome: 'invalid', hash: null, explorerUrl: null };
      throw err;
    }
    seq += 1;
    const accountId = `b${(seq * 104729).toString(16).padStart(8, '0').slice(-8)}.${parent.accountId}`;
    near.set(parent.accountId, bal - amount - GAS);
    near.set(accountId, amount);
    const hash = fakeHash();
    return { accountId, publicKey: `ed25519:mock${seq}`, secretKey: `mock-secret-${seq}`, outcome: 'success', hash, explorerUrl: null };
  }

  async function importTestWallet(accountId, secretKey) {
    const id = String(accountId ?? '').trim();
    if (!/\.testnet$/.test(id)) throw new Error('Enter a NEAR testnet account id, such as name.testnet.');
    if (!near.has(id)) throw new Error(`This key is not on ${id} on NEAR testnet, or the account does not exist.`);
    return { accountId: id, publicKey: 'ed25519:mock-import', secretKey: String(secretKey ?? '').trim() };
  }

  async function view(contractId, method, args = {}) {
    if (contractId !== MOCK_TOKEN) throw new Error(`no such contract ${contractId}`);
    const t = now();
    if (method === 'get_params') return toJson(token.getParams());
    if (method === 'get_state') {
      const total = [...owed.values()].reduce((a, b) => a + b, 0n);
      return toJson({ ...token.getState(t), owed_total: total });
    }
    if (method === 'get_exits') return toJson(token.getExits(args.from_index ?? 0, args.limit ?? 100));
    if (method === 'get_account') return toJson(token.getAccount(args.account_id));
    if (method === 'get_owed') return (owed.get(args.account_id) ?? 0n).toString();
    if (method === 'is_registered') return registered.has(args.account_id);
    if (method === 'quote_buy') return token.quoteBuy(BigInt(args.near)).toString();
    if (method === 'quote_sell') return token.quoteSell(BigInt(args.amount)).toString();
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
    const out = {
      ok: false, outcome: 'failure', hash, value: null, errorCode: null, errorMessage: null, logs: [], events: [],
      explorerUrl: null, settled: false, settlement: null, payoutsFailed: [], mock: true,
    };
    const deposit = BigInt(depositYocto);
    const bal = near.get(who) ?? 0n;
    if (contractId !== MOCK_TOKEN || deposit + GAS > bal) {
      return { ...out, outcome: 'invalid', hash: null, errorMessage: 'the account does not have enough NEAR for this transaction' };
    }
    const t = now();
    const seen = token.events.length;
    const extra = []; // events the engine does not emit: payout_failed, claim
    let credit = 0n; // NEAR that comes back to the caller
    const pay = (account, amount) => {
      if (amount <= 0n) return;
      if (payoutFails) {
        owed.set(account, (owed.get(account) ?? 0n) + amount);
        extra.push({ event: 'payout_failed', data: { account, amount } });
        out.payoutsFailed.push({ account, amount: amount.toString() });
      } else if (account === who) {
        credit += amount;
      } else {
        near.set(account, (near.get(account) ?? 0n) + amount);
      }
    };
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
        // The contract's buy event also names the storage fee it took.
        const ev = token.events[token.events.length - 1];
        if (ev && ev.event === 'buy') ev.data = { ...ev.data, storage_paid: storage };
      } else if (method === 'sell') {
        token.sell(who, BigInt(args.amount), BigInt(args.min_near_out ?? 0), t);
        out.value = token.last_near_out.toString();
        pay(who, token.last_near_out);
      } else if (method === 'shout') {
        out.value = token.shout(who, BigInt(args.amount), t).toString();
      } else if (method === 'leave') {
        out.value = token.leave(who, BigInt(args.exit_id), BigInt(args.min_near_out ?? 0), t).toString();
        pay(who, token.last_near_out);
      } else if (method === 'hush') {
        token.hush(who, BigInt(args.exit_id), t);
      } else if (method === 'catch') {
        const ex = token.getExits(0, 10_000).find((e) => e.id === BigInt(args.exit_id));
        if (ex && ex.owner !== who) reg();
        out.value = token.catch(who, BigInt(args.exit_id), args.amount === undefined || args.amount === null ? null : BigInt(args.amount), deposit, t).toString();
        pay(ex.owner, token.last_catch.to_owner);
        credit += token.last_catch.refund;
      } else if (method === 'claim') {
        const amount = owed.get(who) ?? 0n;
        if (amount === 0n) fail('E_NOTHING_OWED', 'no failed payout is recorded for this account');
        owed.delete(who);
        credit += amount;
        extra.push({ event: 'claim', data: { account: who, amount } });
        out.value = amount.toString();
      } else {
        fail('E_METHOD', `mock has no method ${method}`);
      }
      out.ok = true;
      out.outcome = 'success';
      out.settled = out.payoutsFailed.length === 0;
      out.settlement = out.settled ? 'settled' : 'payout_failed';
      near.set(who, (near.get(who) ?? 0n) - deposit - GAS + credit);
      out.events = toJson([
        ...token.events.slice(seen).map((e) => ({ standard: e.event === 'ft_transfer' ? 'nep141' : 'loud', event: e.event, data: e.data })),
        ...extra.map((e) => ({ standard: 'loud', ...e })),
      ]);
    } catch (e) {
      near.set(who, bal - GAS);
      if (e instanceof LoudError) {
        out.errorCode = e.code;
        out.errorMessage = e.message;
      } else {
        out.errorMessage = e && e.message ? e.message : String(e);
      }
    }
    if (out.hash) results.set(out.hash, out);
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
    createSubWallet,
    importTestWallet,
    exportWallet: (w) => ({ ...w }),
    importWallet: (o) => cleanWallet(o),
    view,
    accountState,
    call,
    async txStatus(hash) {
      const r = results.get(hash);
      return r ? { ...r, refusedHash: null, signedHashes: [hash] } : null;
    },
    // Mock only: an account a connected stand-in wallet signs for.
    fundAccount(accountId, yocto) {
      near.set(accountId, (near.get(accountId) ?? 0n) + BigInt(yocto));
    },
    // Invented hashes and accounts: no explorer links.
    txUrl: () => null,
    accountUrl: () => null,
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
