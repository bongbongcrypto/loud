// DOM-free logic for the LOUD page: formatting, the split comparison, the
// sandbox wrapper, the board model, the proof view model and the RPC view-call
// helpers. Nothing here touches document, window or fetch at module level, so
// it runs under `node --test` (see ui-logic.test.mjs).
//
// All rules come from engine.js. This file only drives and formats.

import {
  LoudToken, PerWalletToken, GreedyLoudSeller, PRESETS, runSplitScenario,
  makeRng, NEAR, UNIT, SEC, MIN, HOUR,
} from './engine.js';

export const EXPLORER = 'https://testnet.nearblocks.io';
// Same order as scripts/proof/proof.mjs.
export const RPC_URLS = Object.freeze([
  'https://test.rpc.fastnear.com',
  'https://rpc.testnet.fastnear.com',
  'https://rpc.testnet.near.org',
  'https://near-testnet.drpc.org',
]);

// ---------------------------------------------------------------- formatting

function group(digits) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// "12.5" with 18 decimals -> 12500000000000000000n. Strings only, no floats.
export function parseDecimal(text, decimals) {
  const s = String(text ?? '').replace(/[,\s_]/g, '');
  if (!/^\d+(\.\d*)?$/.test(s)) throw new Error('Enter a positive number, for example 10 or 2.5');
  const [whole, frac = ''] = s.split('.');
  if (frac.length > decimals) throw new Error(`At most ${decimals} decimal places`);
  return BigInt(whole + frac.padEnd(decimals, '0'));
}

// BigInt base units -> decimal string with thousands separators, rounded down.
export function formatUnits(value, decimals, dp = 0) {
  const v = BigInt(value);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  if (dp === 0) return group(whole.toString());
  const frac = ((v % base) * 10n ** BigInt(dp)) / base;
  return `${group(whole.toString())}.${frac.toString().padStart(dp, '0')}`;
}

export const fmtTokens = (units, dp = 0) => formatUnits(units, 18, dp);
export const fmtNear = (yocto, dp = 4) => formatUnits(yocto, 24, dp);

// Whole-token string for an input field (no separators, trailing zeros cut).
export function tokensForInput(units) {
  const v = BigInt(units);
  const whole = v / UNIT;
  const frac = (v % UNIT).toString().padStart(18, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

// 1,250,000 tokens -> "1.25M". Board and axis labels.
export function fmtCompact(units) {
  const n = Number(BigInt(units) / 10n ** 12n) / 1e6;
  const abs = Math.abs(n);
  const cut = (x) => (x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2));
  if (abs >= 1e9) return `${cut(n / 1e9)}B`;
  if (abs >= 1e6) return `${cut(n / 1e6)}M`;
  if (abs >= 1e3) return `${cut(n / 1e3)}K`;
  return cut(n);
}

export function fmtPct(fraction, dp = 1) {
  return `${(fraction * 100).toFixed(dp)}%`;
}

export function fmtBps(bps) {
  const n = Number(bps) / 100;
  return `${Number.isInteger(n) ? n : n.toString()}%`;
}

export function fmtDuration(seconds) {
  const s = Math.round(Number(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m} min ${rs} s` : `${m} min`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h} h ${rm} min` : `${h} h`;
}

export const nsToSeconds = (ns) => Number(BigInt(ns) / SEC);

// Engine clock, relative to launch: "T+1:05".
export function fmtSinceLaunch(ns, launchNs = 0n) {
  const s = nsToSeconds(BigInt(ns) - BigInt(launchNs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const base = `T+${h}:${String(m).padStart(2, '0')}`;
  return sec ? `${base}:${String(sec).padStart(2, '0')}` : base;
}

// Chain clock: "14:03:22" UTC.
export function fmtUtcTime(ns) {
  const d = new Date(Number(BigInt(ns) / 1_000_000n));
  return d.toISOString().slice(11, 19);
}

export function shortAccount(id, max = 22) {
  const s = String(id ?? '');
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

export function shortHash(hash) {
  const s = String(hash ?? '');
  return s.length <= 14 ? s : `${s.slice(0, 6)}…${s.slice(-6)}`;
}

// Only https links from data files are rendered as links.
export function safeUrl(u) {
  return typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/.test(u) ? u : null;
}

const HASH_RE = /^[1-9A-HJ-NP-Za-km-z]{32,50}$/;
const ACCOUNT_RE = /^[a-z0-9._-]{2,64}$/;
export const isAccountId = (s) => typeof s === 'string' && ACCOUNT_RE.test(s);
export const explorerTx = (hash) => (typeof hash === 'string' && HASH_RE.test(hash) ? `${EXPLORER}/txns/${hash}` : null);
export const explorerAccount = (id) => (isAccountId(id) ? `${EXPLORER}/address/${id}` : null);

// ---------------------------------------------------------------- parameters

// Display strings for the nine parameters of SPEC section 3.
export function paramDisplay(p) {
  // Whole minutes up to two hours read as "60 min", matching the SPEC table.
  const minutes = (ns) => {
    const sec = nsToSeconds(ns);
    return sec % 60 === 0 && sec <= 7200 ? `${sec / 60} min` : fmtDuration(sec);
  };
  return {
    total_supply: fmtTokens(p.total_supply),
    creator_alloc: fmtBps(p.creator_alloc_bps),
    virtual_near: `${fmtNear(p.virtual_near, 0)} NEAR`,
    loud_window: minutes(p.loud_window_ns),
    notice: minutes(p.notice_ns),
    exit_window: minutes(p.exit_window_ns),
    cap: `${fmtBps(p.cap_bps)} per ${minutes(p.cap_window_ns)}`,
  };
}

// ---------------------------------------------------------------- exits and the board

const EXIT_KEYS = ['id', 'amount', 'remaining', 'shouted_at', 'ready_at', 'expires_at'];

// Accepts an engine exit (BigInt fields) or a chain exit (decimal strings).
export function normalizeExit(raw) {
  const ex = { owner: String(raw.owner ?? raw.account ?? '') };
  for (const k of EXIT_KEYS) ex[k] = BigInt(raw[k]);
  ex.closed = raw.closed ?? null; // null | 'left' | 'hushed'
  ex.closed_at = raw.closed_at === undefined || raw.closed_at === null ? null : BigInt(raw.closed_at);
  return ex;
}

// NOTICE: shouted, notice running. BOARDING: leave is allowed now.
// LEFT: fully sold through the door. EXPIRED: the exit window ran out.
// HUSHED: the owner took the exit back before it expired.
export function exitStatus(ex, now) {
  const t = BigInt(now);
  if (ex.closed === 'left' || (ex.closed !== 'hushed' && ex.remaining === 0n)) return 'LEFT';
  if (ex.closed === 'hushed') return ex.closed_at !== null && ex.closed_at > ex.expires_at ? 'EXPIRED' : 'HUSHED';
  if (t < ex.ready_at) return 'NOTICE';
  if (t <= ex.expires_at) return 'BOARDING';
  return 'EXPIRED';
}

// Rebuilds every exit, open and closed, from the engine event log. Filled
// exits are removed from the contract state, so the log is the only record.
export function exitsFromEvents(events, noticeNs) {
  const map = new Map();
  for (const { event, t, data } of events) {
    if (event === 'shout') {
      map.set(data.id, {
        id: data.id, owner: data.account, amount: data.amount, remaining: data.amount,
        shouted_at: data.ready_at - BigInt(noticeNs), ready_at: data.ready_at, expires_at: data.expires_at,
        closed: null, closed_at: null,
      });
    } else if (event === 'leave') {
      const ex = map.get(data.id);
      if (!ex) continue;
      ex.remaining = data.remaining;
      if (data.remaining === 0n) { ex.closed = 'left'; ex.closed_at = t; }
    } else if (event === 'hush') {
      const ex = map.get(data.id);
      if (!ex) continue;
      ex.closed = 'hushed';
      ex.closed_at = t;
    }
  }
  return [...map.values()];
}

function statusDetail(ex, status, now) {
  if (status === 'NOTICE') return `ready in ${fmtDuration(nsToSeconds(ex.ready_at - BigInt(now)))}`;
  if (status === 'BOARDING') {
    const left = nsToSeconds(ex.expires_at - BigInt(now));
    const sold = ex.amount - ex.remaining;
    return sold > 0n
      ? `${fmtCompact(sold)} out, ${fmtDuration(left)} left`
      : `${fmtDuration(left)} left`;
  }
  if (status === 'EXPIRED' || status === 'HUSHED') {
    return ex.remaining > 0n ? `${fmtCompact(ex.remaining)} still loud` : '';
  }
  return '';
}

// Rows for the departures board. Open exits first (oldest first), then closed
// ones, most recently closed first. `clock` formats a nanosecond timestamp.
export function boardRows(exits, now, { clock = (ns) => fmtSinceLaunch(ns), limit = 9 } = {}) {
  const list = exits.map(normalizeExit);
  const open = list.filter((e) => e.closed === null).sort((a, b) => (a.id < b.id ? -1 : 1));
  const closed = list.filter((e) => e.closed !== null)
    .sort((a, b) => (a.closed_at === b.closed_at ? (a.id < b.id ? 1 : -1) : a.closed_at < b.closed_at ? 1 : -1));
  // Keep up to three recently closed exits visible even when many are open.
  const closedSlots = Math.min(closed.length, Math.max(3, limit - open.length));
  const rows = [...open.slice(0, limit - closedSlots), ...closed.slice(0, closedSlots)];
  return rows.map((ex) => {
    const status = exitStatus(ex, now);
    return {
      id: ex.id.toString(),
      account: ex.owner,
      amount: fmtCompact(ex.amount),
      amountFull: fmtTokens(ex.amount),
      shouted: clock(ex.shouted_at),
      ready: clock(ex.ready_at),
      status,
      detail: statusDetail(ex, status, now),
      canLeave: status === 'BOARDING',
      canHush: ex.closed === null,
    };
  });
}

// Accelerated engine run for the board at the top of the page: the creator
// allocation of the standard preset, split unevenly across `wallets` accounts,
// leaves as fast as the door allows. step() advances the engine clock.
export function createBoardSim({ wallets = 36, seed = 7, stepNs = MIN } = {}) {
  const params = PRESETS.standard;
  const rng = makeRng(seed);
  const names = Array.from({ length: wallets }, (_, i) => `w${String(i + 1).padStart(2, '0')}.early.testnet`);
  const token = new LoudToken({ ...params, creator: names[0] }, 0n);
  const held = token.getAccount(names[0]).loud;
  const weights = names.map(() => 0.4 + rng());
  const total = weights.reduce((a, b) => a + b, 0);
  for (let i = 1; i < wallets; i++) {
    const part = (held * BigInt(Math.floor((weights[i] / total) * 1e6))) / 1_000_000n;
    token.transferLoud(names[0], names[i], part, 0n);
  }
  let now = params.loud_window_ns;
  for (let i = 0; i < 30; i++) token.buy(`holder-${i}`, 10n * NEAR, 0n, now);
  const seller = new GreedyLoudSeller(token, names, stepNs);
  return {
    token,
    get now() { return now; },
    step() {
      now += stepNs;
      seller.step(now);
      return now;
    },
    get done() { return seller.holdings() === 0n; },
    exits() { return exitsFromEvents(token.events, token.getParams().notice_ns); },
    state() { return token.getState(now); },
  };
}

// ---------------------------------------------------------------- split comparison

export const SPLIT_HORIZON_NS = 6n * HOUR;
export const WALLET_CHOICES = Object.freeze([1, 10, 100, 1000]);
export const SHARE_CHOICES_BPS = Object.freeze([500, 1000, 2000]);

function sellOutSeconds(series) {
  const p = series.find((x) => x.insiderSold >= 0.999999);
  return p ? p.t - series[0].t : null;
}

function firstSaleSeconds(series) {
  const p = series.find((x) => x.insiderSold > 0);
  return p ? p.t - series[0].t : null;
}

function soldAtSeconds(series, seconds) {
  const p = series.find((x) => x.t - series[0].t === seconds);
  return p ? p.insiderSold : null;
}

function maxDiffUnits(a, b) {
  let max = 0n;
  for (let i = 0; i < a.length && i < b.length; i++) {
    const x = BigInt(a[i].insiderSoldUnits);
    const y = BigInt(b[i].insiderSoldUnits);
    const d = x > y ? x - y : y - x;
    if (d > max) max = d;
  }
  return max;
}

function priceStats(series) {
  const p0 = series[0].price;
  let min = p0;
  for (const p of series) if (p.price < min) min = p.price;
  return { start: p0, dropAfter1Min: 1 - series[1].price / p0, maxDrop: 1 - min / p0, end: series.at(-1).price };
}

// Runs the same insider under the three rule sets, with `wallets` accounts and
// with one account as the reference. `cache` (a Map) keeps earlier runs.
export function runComparison({ wallets, shareBps }, cache = new Map()) {
  const run = (rule, n) => {
    const key = `${rule}/${n}/${shareBps}`;
    if (!cache.has(key)) {
      cache.set(key, runSplitScenario({
        rule, wallets: n, insiderShareBps: shareBps, horizonNs: SPLIT_HORIZON_NS, stepNs: 60n * SEC,
      }));
    }
    return cache.get(key);
  };
  const series = {
    naive: run('naive', wallets),
    per_wallet: run('per_wallet', wallets),
    loud: run('loud', wallets),
  };
  const single = { naive: run('naive', 1), per_wallet: run('per_wallet', 1), loud: run('loud', 1) };

  const ref = new PerWalletToken(PRESETS.standard, 0n);
  const perTxBps = Number((ref.max_sell_units * 10000n) / ref.total_supply);
  const horizonSec = nsToSeconds(SPLIT_HORIZON_NS);
  const stats = {
    wallets,
    shareBps,
    horizonSec,
    stepSec: 60,
    naive: { sellOutSec: sellOutSeconds(series.naive), price: priceStats(series.naive) },
    per_wallet: {
      sellOutSec: sellOutSeconds(series.per_wallet),
      sellOutSecSingle: sellOutSeconds(single.per_wallet),
      perTxBps,
      cooldownSec: nsToSeconds(ref.cooldown_ns),
      allowedBpsPerCooldown: perTxBps * wallets,
      price: priceStats(series.per_wallet),
    },
    loud: {
      sellOutSec: sellOutSeconds(series.loud),
      firstSaleSec: firstSaleSeconds(series.loud),
      soldAfter1h: soldAtSeconds(series.loud, 3600),
      soldAtEnd: series.loud.at(-1).insiderSold,
      soldAtEndSingle: single.loud.at(-1).insiderSold,
      maxDiffUnits: maxDiffUnits(series.loud, single.loud),
      capBps: Number(PRESETS.standard.cap_bps),
      capWindowSec: nsToSeconds(PRESETS.standard.cap_window_ns),
      noticeSec: nsToSeconds(PRESETS.standard.notice_ns),
      price: priceStats(series.loud),
    },
  };
  stats.per_wallet.speedup = stats.per_wallet.sellOutSec && stats.per_wallet.sellOutSecSingle
    ? stats.per_wallet.sellOutSecSingle / stats.per_wallet.sellOutSec
    : null;
  return { series, single, stats };
}

const times = (x) => (Number.isInteger(x) ? `${x}x` : `${x.toFixed(1)}x`);
const took = (sec, horizonSec) => (sec === null ? `more than ${fmtDuration(horizonSec)}` : fmtDuration(sec));

// Plain result sentences, every number taken from the run.
export function resultSentences(stats) {
  const { wallets: n, naive, per_wallet: pw, loud, horizonSec } = stats;
  const out = [];
  const horizon = fmtDuration(horizonSec);
  out.push({
    rule: 'naive',
    text: naive.sellOutSec === null
      ? `No rule: the position was not fully sold within ${horizon}.`
      : `No rule: the whole position was sold within ${fmtDuration(naive.sellOutSec)}, ${n === 1 ? 'in one transaction' : `with ${n} wallets or with one`}.`,
  });
  if (n === 1) {
    out.push({
      rule: 'per_wallet',
      text: `Per-wallet limits: one wallet needed ${took(pw.sellOutSec, horizonSec)} to sell the whole position. Pick 10 or more wallets to see what splitting does to this rule.`,
    });
    out.push({
      rule: 'loud',
      text: `LOUD: nothing left before minute ${Math.round((loud.firstSaleSec ?? 0) / 60)}; ${fmtPct(loud.soldAtEnd)} of the position was out after ${horizon}.`,
    });
    return out;
  }
  const floor = pw.sellOutSec === stats.stepSec ? ' The run steps one minute at a time, so 1 min is the fastest it can show.' : '';
  out.push({
    rule: 'per_wallet',
    text: pw.speedup === null
      ? `Per-wallet limits: 1 wallet needed ${took(pw.sellOutSecSingle, horizonSec)} to sell the whole position, ${n} wallets needed ${took(pw.sellOutSec, horizonSec)}.`
      : `Per-wallet limits: 1 wallet needed ${fmtDuration(pw.sellOutSecSingle)} to sell the whole position, ${n} wallets needed ${fmtDuration(pw.sellOutSec)}. Splitting made the sale ${times(pw.speedup)} faster.${floor} The rule allows ${fmtBps(pw.perTxBps)} of supply per wallet every ${fmtDuration(pw.cooldownSec)}, so its limit grows with the number of wallets: ${n} x ${fmtBps(pw.perTxBps)} here.`,
  });
  const same = loud.maxDiffUnits === 0n
    ? 'The two lines are identical.'
    : `Largest difference at any minute: ${loud.maxDiffUnits} units (1 token is 10^18 units), from rounding when the position was divided.`;
  out.push({
    rule: 'loud',
    text: `LOUD: 1 wallet and ${n} wallets sold the same amount at every minute. ${same} Nothing left before minute ${Math.round((loud.firstSaleSec ?? 0) / 60)}; ${fmtPct(loud.soldAtEnd)} of the position was out after ${horizon}.`,
  });
  return out;
}

// One line per rule set for the results table.
export function resultTable(stats) {
  const { horizonSec } = stats;
  const row = (label, s, single) => ({
    label,
    single: took(single, horizonSec),
    split: took(s.sellOutSec, horizonSec),
    drop1: fmtPct(s.price.dropAfter1Min),
    dropMax: fmtPct(s.price.maxDrop),
  });
  return [
    row('No rule', stats.naive, stats.naive.sellOutSec),
    row('Per-wallet limits', stats.per_wallet, stats.per_wallet.sellOutSecSingle),
    { ...row('LOUD', stats.loud, stats.loud.sellOutSec), note: `${fmtPct(stats.loud.soldAtEnd)} out after ${fmtDuration(horizonSec)}` },
  ];
}

// ---------------------------------------------------------------- chart geometry

export function linear(d0, d1, r0, r1) {
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
  return (v) => r0 + (v - d0) * k;
}

// points: [[x, y], ...] already in pixels.
export function pathFrom(points) {
  let d = '';
  let last = null;
  for (const [x, y] of points) {
    const s = `${x.toFixed(1)},${y.toFixed(1)}`;
    if (s === last) continue;
    d += `${d ? 'L' : 'M'}${s}`;
    last = s;
  }
  return d;
}

// Series cut to the first `minutes` after the insider starts: [[minute, value]].
export function seriesPoints(series, key, minutes) {
  const t0 = series[0].t;
  const out = [];
  for (const p of series) {
    const m = (p.t - t0) / 60;
    if (m > minutes) break;
    out.push([m, p[key]]);
  }
  return out;
}

export function niceTicks(max, count = 4) {
  if (!(max > 0)) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const ticks = [];
  for (let v = 0; v <= max + step * 1e-9; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

// ---------------------------------------------------------------- sandbox

export const SANDBOX_ACCOUNTS = Object.freeze(['you.testnet', 'you-2.testnet']);

// A LoudToken with a hand-driven clock. Every action returns
// { ok, call, message } and is appended to .log; a failed call carries the
// engine error text unchanged.
export class Sandbox {
  constructor(params = PRESETS.standard) {
    this.params = params;
    this.reset();
  }

  reset() {
    this.token = new LoudToken({ ...this.params, creator: 'creator.testnet' }, 0n);
    this.now = 0n;
    this.account = SANDBOX_ACCOUNTS[0];
    this.log = [];
    this.near_in = 0n;
    this.near_out = 0n;
  }

  other() {
    return this.account === SANDBOX_ACCOUNTS[0] ? SANDBOX_ACCOUNTS[1] : SANDBOX_ACCOUNTS[0];
  }

  switchAccount() {
    this.account = this.other();
  }

  skip(ns) {
    this.now += BigInt(ns);
  }

  _run(call, parse, fn, describe) {
    const entry = { t: this.now, account: this.account, call, ok: false, code: null, message: '' };
    try {
      const args = parse();
      const result = fn(args);
      entry.ok = true;
      entry.message = describe(result, args);
    } catch (e) {
      entry.code = e && e.code ? e.code : 'INPUT';
      entry.message = e && e.message ? e.message : String(e);
    }
    this.log.push(entry);
    return entry;
  }

  buy(nearText) {
    const loudWindow = this.token.getState(this.now).is_loud_window;
    return this._run(`buy with ${nearText} NEAR`, () => parseDecimal(nearText, 24),
      (n) => { const out = this.token.buy(this.account, n, 0n, this.now); this.near_in += n; return out; },
      (out) => `Bought ${fmtTokens(out)} LOUD. They are ${loudWindow ? 'loud: bought inside the launch window' : 'quiet: bought after the launch window'}.`);
  }

  sell(tokensText) {
    return this._run(`sell ${tokensText}`, () => parseDecimal(tokensText, 18),
      (x) => { const out = this.token.sell(this.account, x, 0n, this.now); this.near_out += out; return out; },
      (out, x) => `Sold ${fmtTokens(x)} quiet LOUD for ${fmtNear(out)} NEAR.`);
  }

  shout(tokensText) {
    return this._run(`shout ${tokensText}`, () => parseDecimal(tokensText, 18),
      (x) => this.token.shout(this.account, x, this.now),
      (id, x) => {
        const p = this.token.getParams();
        return `Exit ${id} is on the board: ${fmtTokens(x)} LOUD escrowed. Leave opens at ${fmtSinceLaunch(this.now + p.notice_ns)} and closes at ${fmtSinceLaunch(this.now + p.notice_ns + p.exit_window_ns)}.`;
      });
  }

  leave(exitId) {
    return this._run(`leave exit ${exitId}`, () => BigInt(exitId),
      (id) => {
        const fill = this.token.leave(this.account, id, 0n, this.now);
        const near = this.token.last_near_out;
        this.near_out += near;
        const still = this.token.getExits(0, 100).find((e) => e.id === id);
        return { fill, near, remaining: still ? still.remaining : 0n };
      },
      (r) => (r.remaining === 0n
        ? `Left with ${fmtTokens(r.fill)} LOUD for ${fmtNear(r.near)} NEAR. The exit is complete.`
        : `Partial fill: ${fmtTokens(r.fill)} LOUD left for ${fmtNear(r.near)} NEAR. The cap had no more room; ${fmtTokens(r.remaining)} LOUD stay in the exit.`));
  }

  hush(exitId) {
    return this._run(`hush exit ${exitId}`, () => BigInt(exitId),
      (id) => this.token.hush(this.account, id, this.now),
      (back) => `Exit closed. ${fmtTokens(back)} LOUD returned to your balance, still loud.`);
  }

  // Sends half of the loud balance to the second account with ft_transfer.
  splitHalf() {
    const to = this.other();
    return this._run(`ft_transfer half of the loud balance to ${to}`,
      () => {
        const acc = this.token.getAccount(this.account);
        if (acc.loud < 2n * UNIT) throw new Error('No free loud balance to send. Loud tokens in an open exit are escrowed; hush the exit first.');
        // ft_transfer takes quiet first; send all quiet plus half of the loud.
        return { amount: acc.quiet + acc.loud / 2n };
      },
      ({ amount }) => this.token.transfer(this.account, to, amount, this.now),
      (r) => `Sent ${fmtTokens(r.loud_amount)} loud and ${fmtTokens(r.quiet_amount)} quiet LOUD to ${to}. The loud tag moved with the tokens.`);
  }

  view() {
    const token = this.token;
    const p = token.getParams();
    const s = token.getState(this.now);
    const acc = token.getAccount(this.account);
    const other = token.getAccount(this.other());
    const exits = exitsFromEvents(token.events, p.notice_ns);
    const rows = boardRows(exits, this.now, { limit: 12 }).map((r) => {
      const ex = exits.find((e) => e.id.toString() === r.id);
      const mine = ex.owner === this.account;
      // Leave is offered on every open exit of the active account, so a visitor
      // can try it during the notice or after expiry and read the engine error.
      return { ...r, mine, canLeave: r.canHush && mine, canHush: r.canHush && mine };
    });
    const capFraction = Number((s.cap_available * 10000n) / s.cap_units) / 10000;
    return {
      clock: fmtSinceLaunch(this.now),
      loudWindowOpen: s.is_loud_window,
      loudWindowText: s.is_loud_window
        ? `Launch window open for ${fmtDuration(nsToSeconds(p.loud_until - this.now))} more: buys are loud.`
        : 'Launch window closed: buys are quiet.',
      account: this.account,
      otherAccount: this.other(),
      loud: acc.loud,
      quiet: acc.quiet,
      escrowed: acc.exits.reduce((a, e) => a + e.remaining, 0n),
      otherLoud: other.loud,
      otherQuiet: other.quiet,
      nearIn: this.near_in,
      nearOut: this.near_out,
      capAvailable: s.cap_available,
      capUnits: s.cap_units,
      capFraction,
      capText: `${fmtTokens(s.cap_available)} of ${fmtTokens(s.cap_units)} LOUD may leave now`,
      nextRoomText: s.cap_available > 0n ? ''
        : s.next_room_ts - this.now < MIN ? 'The cap is empty and refills continuously; the first room is back within a minute'
          : `Room returns at ${fmtSinceLaunch(s.next_room_ts)}`,
      price: token.price(),
      poolNear: s.pool_near,
      loudOutstanding: s.loud_outstanding,
      totalLeft: s.total_left,
      rows,
      log: this.log,
    };
  }
}

// ---------------------------------------------------------------- chain views

// Browser and Node 18+ both have btoa, atob and TextDecoder.
export function viewRequest(accountId, methodName, args = {}, id = 1) {
  if (!isAccountId(accountId)) throw new Error('invalid account id');
  return {
    jsonrpc: '2.0',
    id,
    method: 'query',
    params: {
      request_type: 'call_function',
      finality: 'final',
      account_id: accountId,
      method_name: methodName,
      args_base64: btoa(JSON.stringify(args)),
    },
  };
}

export function decodeViewResult(body) {
  if (!body || typeof body !== 'object') throw new Error('empty RPC response');
  if (body.error) throw new Error(`RPC error: ${JSON.stringify(body.error).slice(0, 200)}`);
  const r = body.result;
  if (!r) throw new Error('RPC response has no result');
  if (r.error) throw new Error(`view error: ${String(r.error).slice(0, 200)}`);
  if (!Array.isArray(r.result)) throw new Error('RPC result has no bytes');
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(r.result)));
}

// Tries each URL in order. `fetchFn` is injected so this stays testable.
export async function callView(fetchFn, urls, accountId, methodName, args = {}, timeoutMs = 8000) {
  const body = JSON.stringify(viewRequest(accountId, methodName, args));
  let last = null;
  for (const url of urls) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchFn(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return decodeViewResult(await res.json());
    } catch (e) {
      last = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`no RPC endpoint answered ${methodName}: ${last && last.message ? last.message : last}`);
}

const DECIMAL = /^[0-9]+$/;

// Decimal strings from the chain -> BigInt, everything else unchanged.
export function bigFields(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) out[k] = typeof v === 'string' && DECIMAL.test(v) ? BigInt(v) : v;
  return out;
}

// get_params + get_state + get_exits of the deployed token.
export async function fetchLive(fetchFn, accountId, urls = RPC_URLS) {
  const [params, state, exits] = await Promise.all([
    callView(fetchFn, urls, accountId, 'get_params'),
    callView(fetchFn, urls, accountId, 'get_state'),
    callView(fetchFn, urls, accountId, 'get_exits', { from_index: 0, limit: 100 }),
  ]);
  return {
    params: bigFields(params),
    state: bigFields(state),
    exits: (Array.isArray(exits) ? exits : []).map(normalizeExit),
  };
}

// Facts shown next to the live board. Time comes from get_state.now.
export function liveFacts(live) {
  const { params: p, state: s } = live;
  return [
    ['Chain time (UTC)', fmtUtcTime(s.now)],
    ['Cap room now', `${fmtTokens(s.cap_available)} of ${fmtTokens(s.cap_units)} LOUD`],
    ['Loud supply outstanding', `${fmtTokens(s.loud_outstanding)} LOUD`],
    ['In open exits', `${fmtTokens(s.escrowed)} LOUD in ${s.open_exits} exits`],
    ['Left through the door so far', `${fmtTokens(s.total_left)} LOUD in ${s.leave_count} leave calls`],
    ['Launch window', s.is_loud_window ? 'open' : 'closed'],
    ['Notice / exit window', `${fmtDuration(nsToSeconds(p.notice_ns))} / ${fmtDuration(nsToSeconds(p.exit_window_ns))}`],
    ['Cap', `${fmtBps(p.cap_bps)} of supply per ${fmtDuration(nsToSeconds(p.cap_window_ns))}`],
  ];
}

// ---------------------------------------------------------------- proof view model

const text = (v) => (v === null || v === undefined ? '' : String(v));
const stateOf = (o) => (o && (o.status === 'ok' || o.status === 'failed') ? o.status : 'pending');

export function deploymentView(dep) {
  const d = dep && typeof dep === 'object' ? dep : {};
  const state = stateOf(d);
  const token = isAccountId(d.token_account) ? d.token_account : null;
  const keysKnown = Array.isArray(d.access_keys);
  // "Zero keys" only when the flag and the key list agree.
  const zeroKeys = d.zero_keys === true && keysKnown && d.access_keys.length === 0;
  const keysText = !token || !keysKnown
    ? 'not checked yet'
    : zeroKeys
      ? '0 access keys. view_access_key_list returned an empty list.'
      : `${d.access_keys.length} access keys found. The zero-key claim does not hold for this deployment.`;
  const ex = d.explorer || {};
  const run = d.run || {};
  const repo = typeof run.repository === 'string' && /^[\w.-]+\/[\w.-]+$/.test(run.repository) ? run.repository : null;
  const runUrl = repo && /^\d+$/.test(text(run.run_id)) ? `https://github.com/${repo}/actions/runs/${run.run_id}` : null;
  const rows = [];
  const add = (label, value, href = null) => { if (value) rows.push({ label, value, href }); };
  add('Token account', token, safeUrl(ex.token) || explorerAccount(token));
  add('Access keys on the token account', token ? keysText : '');
  add('Deploy transaction', text(d.tx), safeUrl(ex.tx) || explorerTx(d.tx));
  add('Deployed at', text(d.deployed_at));
  add('Preset', text(d.preset));
  add('Creator account', isAccountId(d.creator_account) ? d.creator_account : '', explorerAccount(d.creator_account));
  add('Code hash on chain', text(d.code_hash));
  add('Wasm sha256', d.wasm ? `${text(d.wasm.sha256)} (${text(d.wasm.bytes)} bytes)` : '');
  add('CI run that produced this', runUrl ? `run ${run.run_id}` : '', runUrl);
  add('Commit', repo && /^[0-9a-f]{7,40}$/.test(text(run.commit)) ? run.commit.slice(0, 12) : '',
    repo && /^[0-9a-f]{7,40}$/.test(text(run.commit)) ? `https://github.com/${repo}/commit/${run.commit}` : null);
  return {
    state,
    token,
    zeroKeys,
    keysKnown: Boolean(token) && keysKnown,
    headline: state === 'pending'
      ? 'Pending. The token is not deployed yet, or the proof run has not been committed.'
      : state === 'ok' && zeroKeys
        ? 'Deployed. The token account has zero access keys.'
        : state === 'ok'
          ? 'Deployed. The zero-key check is not confirmed by this file; see the access key row.'
          : 'The last proof run failed. What it recorded is shown below.',
    rows,
    repo,
    generatedAt: text(d.generated_at),
  };
}

function txView(tx) {
  const t = tx && typeof tx === 'object' ? tx : {};
  const outcome = ['success', 'failure', 'invalid', 'unknown'].includes(t.outcome) ? t.outcome : 'unknown';
  let note = '';
  if (t.filled !== undefined && t.filled !== null && DECIMAL.test(text(t.filled))) note = `filled ${fmtTokens(BigInt(t.filled))}`;
  else if (t.error_code) note = text(t.error_code);
  else if (t.error) note = text(t.error).slice(0, 120);
  return {
    hash: text(t.hash),
    short: t.hash ? shortHash(t.hash) : 'no hash',
    href: explorerTx(t.hash),
    account: text(t.account),
    outcome,
    round: t.round === undefined || t.round === null ? '' : text(t.round),
    note,
  };
}

export function receiptsView(rec) {
  const r = rec && typeof rec === 'object' ? rec : {};
  const state = stateOf(r);
  const steps = (Array.isArray(r.steps) ? r.steps : [])
    .filter((s) => s && typeof s === 'object')
    .sort((a, b) => Number(a.n) - Number(b.n))
    .map((s) => {
      const txs = (Array.isArray(s.txs) ? s.txs : []).map(txView);
      return {
        n: text(s.n),
        title: text(s.title),
        expect: text(s.expect),
        got: text(s.got),
        result: s.ok === true ? 'PASS' : 'FAIL',
        txs,
        txSummary: txs.length === 0 ? 'no transactions'
          : `${txs.length} transaction${txs.length === 1 ? '' : 's'}: ${txs.filter((t) => t.outcome === 'success').length} succeeded, ${txs.filter((t) => t.outcome === 'failure').length} failed on chain as recorded`,
      };
    });
  const sp = r.split && typeof r.split === 'object' ? r.split : {};
  const units = (v) => (DECIMAL.test(text(v)) ? `${fmtTokens(BigInt(v))} LOUD` : 'pending');
  const haveSplit = DECIMAL.test(text(sp.sold_total)) && DECIMAL.test(text(sp.bound));
  let windowText = 'pending';
  if (DECIMAL.test(text(sp.window_start_ns)) && DECIMAL.test(text(sp.measured_until_ns))) {
    windowText = fmtDuration(nsToSeconds(BigInt(sp.measured_until_ns) - BigInt(sp.window_start_ns)));
  }
  const split = {
    have: haveSplit,
    result: !haveSplit ? 'PENDING' : sp.pass === true ? 'PASS' : 'FAIL',
    sentence: !haveSplit
      ? 'No split measurement yet.'
      : `${text(sp.wallets)} wallets sold ${units(sp.sold_total)} in ${windowText}. The cap allowed at most ${units(sp.bound)} in that time.`,
    rows: [
      ['Wallets', text(sp.wallets)],
      ['Cap per window', units(sp.cap_units)],
      ['Cap room when the window started', units(sp.bucket_at_start)],
      ['Measured for', windowText],
      ['Sold in the first cap window (limit: room at start + one cap)', units(sp.sold_in_window)],
      ['Sold in the whole measurement', units(sp.sold_total)],
      ['Upper bound from the cap (SPEC invariant 4)', units(sp.bound)],
      ['Leave calls sent / filled / rejected with E_CAP', `${text(sp.attempts)} / ${text(sp.fills)} / ${text(sp.cap_hits)}`],
      ['Receipts match the contract counter', sp.receipts_match_counter === true ? 'yes' : sp.receipts_match_counter === false ? 'no' : 'pending'],
    ],
  };
  const passed = steps.filter((s) => s.result === 'PASS').length;
  return {
    state,
    headline: state === 'pending'
      ? 'Pending. No proof run has been recorded yet.'
      : state === 'ok'
        ? `All ${steps.length} steps passed on NEAR testnet.`
        : `The run did not pass: ${passed} of ${steps.length} recorded steps passed.`,
    steps,
    split,
    error: text(r.error),
    generatedAt: text(r.generated_at),
  };
}

// Source repository, when the page is served from GitHub Pages.
export function repoFromLocation(hostname, pathname) {
  const m = /^([a-z0-9-]+)\.github\.io$/i.exec(hostname || '');
  const seg = String(pathname || '').split('/').filter(Boolean)[0];
  return m && seg && /^[\w.-]+$/.test(seg) ? `https://github.com/${m[1]}/${seg}` : null;
}
