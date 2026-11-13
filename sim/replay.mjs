// Replay of real launches through the three rule sets.
//
//   node sim/replay.mjs
//       reads every data file in sim/replay-data/ and writes sim/REPLAY.md (offline)
//   node sim/replay.mjs --data <folder> --out <folder>
//       reads the data files from another folder and writes REPLAY.md into another
//   node sim/replay.mjs --fetch --network solana --pool <pool address> --hours 6 \
//       --label "<name>" --bundled-bps <share of supply held by the bundle> \
//       --wallets <number of bundle wallets> --doc-url <public report> \
//       [--from <ISO time to start at; default is the pool creation time>]
//       downloads minute candles from the GeckoTerminal public API (no key) into
//       the data folder. The public API only serves the last 180 days.
//
// Two kinds of data file:
//   sell_schedule  the measured sales of a set of bundle wallets, minute by
//                  minute, as shares of supply.
//                  measured  the schedule and the wallet count
//                  model     the pool the selling is replayed into, and that
//                            LOUD bundle wallets shout at the first moment they
//                            wanted to sell
//   ohlcv_minute   minute candles of a pool.
//                  measured  open/high/low/close and USD volume, total supply,
//                            and the bundle share and wallet count taken from
//                            the cited public report
//                  model     the split of volume into buys and sells, which
//                            sells belong to the bundle, and the pool

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PRESETS, NEAR, SEC, makeToken, makeSeller } from '../web/engine.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, 'replay-data');
const API = 'https://api.geckoterminal.com/api/v2';
const TICK = 60n * SEC;
const RULES = ['naive', 'per_wallet', 'loud'];
const CROWD_NEAR = 300n * NEAR;
// Minutes after launch at which the schedule replay reports.
export const CHECKPOINTS = [1, 5, 10, 30, 60, 360, 1440];
// The schedule replay stops here if a rule has still not sold everything.
const MAX_MINUTES = 30 * 24 * 60;

// Loader

export function validateSchedule(data) {
  const need = ['label', 'chain', 'token', 'launch_ts', 'sources', 'bundle', 'aggregated_by_minute'];
  for (const k of need) if (data[k] === undefined) throw new Error(`data file is missing "${k}"`);
  if (!(Number(data.token.total_supply) > 0)) throw new Error('token.total_supply must be positive');
  if (!Array.isArray(data.sources) || data.sources.length === 0 || data.sources.some((x) => !String(x.url).startsWith('https://'))) {
    throw new Error('sources must list at least one https url');
  }
  if (!Array.isArray(data.bundle.wallets) || data.bundle.wallets.length === 0) throw new Error('bundle.wallets is empty');
  const rows = data.aggregated_by_minute;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('aggregated_by_minute is empty');
  let last = -1;
  let sum = 0;
  for (const r of rows) {
    if (!Number.isInteger(r.minute) || r.minute < 0) throw new Error('schedule minute must be a whole number, 0 or more');
    if (r.minute <= last) throw new Error('schedule minutes are not in ascending order');
    if (!(r.share_of_supply_bps > 0)) throw new Error('schedule share_of_supply_bps must be positive');
    last = r.minute;
    sum += r.share_of_supply_bps;
  }
  if (sum > 10000) throw new Error('the schedule sells more than the whole supply');
  return data;
}

export function validateData(data) {
  if (data.kind === 'sell_schedule') return validateSchedule(data);
  const need = ['label', 'network', 'pool', 'total_supply', 'candles', 'documented', 'source'];
  for (const k of need) if (data[k] === undefined) throw new Error(`data file is missing "${k}"`);
  if (!Array.isArray(data.candles) || data.candles.length < 2) throw new Error('data file has no candles');
  let last = -Infinity;
  for (const c of data.candles) {
    if (!Array.isArray(c) || c.length < 6 || c.some((x) => typeof x !== 'number' || !Number.isFinite(x))) {
      throw new Error('candle is not [timestamp, open, high, low, close, volume_usd]');
    }
    if (c[0] <= last) throw new Error('candles are not in ascending time order');
    last = c[0];
  }
  const bps = data.documented.bundled_share_bps;
  if (!(bps > 0 && bps <= 10000)) throw new Error('documented.bundled_share_bps must be in 1..10000');
  if (!(Number(data.total_supply) > 0)) throw new Error('total_supply must be positive');
  return data;
}

export function loadDataFiles(dir = DATA_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({ file: f, data: validateData(JSON.parse(readFileSync(join(dir, f), 'utf8'))) }));
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'ohlcv-replay-script' } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} from ${url}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

export async function fetchData({ network, pool, hours = 6, from = null, label, bundledBps, wallets, docUrl }) {
  const poolUrl = `${API}/networks/${network}/pools/${pool}`;
  const poolInfo = await getJson(poolUrl);
  const attrs = poolInfo.data.attributes;
  const tokenAddress = poolInfo.data.relationships.base_token.data.id.split('_').slice(1).join('_');
  const tokenUrl = `${API}/networks/${network}/tokens/${tokenAddress}`;
  const tokenInfo = await getJson(tokenUrl);
  const t = tokenInfo.data.attributes;
  const totalSupply = t.normalized_total_supply !== undefined && t.normalized_total_supply !== null
    ? Number(t.normalized_total_supply)
    : Number(t.total_supply) / 10 ** Number(t.decimals);
  const start = Math.floor(new Date(from || attrs.pool_created_at).getTime() / 1000);
  const end = start + hours * 3600;
  const urls = [];
  const byTs = new Map();
  let before = end;
  while (before > start) {
    const url = `${poolUrl}/ohlcv/minute?aggregate=1&before_timestamp=${before}&limit=1000&currency=usd&token=base`;
    urls.push(url);
    const page = (await getJson(url)).data.attributes.ohlcv_list;
    if (page.length === 0) break;
    let oldest = before;
    for (const c of page) {
      if (c[0] >= start && c[0] < end) byTs.set(c[0], c.map(Number));
      if (c[0] < oldest) oldest = c[0];
    }
    if (oldest >= before) break;
    before = oldest;
  }
  const candles = [...byTs.values()].sort((a, b) => a[0] - b[0]);
  return validateData({
    kind: 'ohlcv_minute',
    label,
    network,
    pool,
    token: tokenAddress,
    token_symbol: t.symbol,
    pool_created_at: attrs.pool_created_at,
    total_supply: totalSupply,
    documented: { bundled_share_bps: bundledBps, wallets, source_url: docUrl },
    source: { provider: 'GeckoTerminal public API', urls: [poolUrl, tokenUrl, ...urls], fetched_at: new Date().toISOString() },
    candles,
  });
}

// Model

// Splits each minute of real volume into a flow, as a share of supply.
// Model rule: a minute that closes below its open is counted as selling, any
// other minute as buying. Selling counts as bundle selling until the documented
// bundle share is used up.
export function deriveFlows(data) {
  const supply = Number(data.total_supply);
  const bundle = data.documented.bundled_share_bps / 10000;
  let used = 0;
  return data.candles.map(([ts, open, , , close, volumeUsd]) => {
    const mid = (open + close) / 2;
    const share = mid > 0 ? volumeUsd / mid / supply : 0;
    const flow = { ts, close, volumeUsd, buy: 0, bundleSell: 0, otherSell: 0 };
    if (close < open) {
      flow.bundleSell = Math.min(share, bundle - used);
      flow.otherSell = share - flow.bundleSell;
      used += flow.bundleSell;
    } else {
      flow.buy = share;
    }
    return flow;
  });
}

function shareToUnits(token, share) {
  return (token.total_supply * BigInt(Math.round(share * 1e9))) / 1_000_000_000n;
}

function maxDropWithin(values, window) {
  let worst = 0;
  for (let k = 1; k < values.length; k++) {
    let peak = 0;
    for (let j = Math.max(0, k - window); j < k; j++) if (values[j] > peak) peak = values[j];
    if (peak > 0) worst = Math.max(worst, 1 - values[k] / peak);
  }
  return worst;
}

// Replays the bundle selling into a pool with the SPEC standard preset under one rule.
// The bundle holds the documented share from the first block; under LOUD it is
// loud supply. The bundle tries to sell at the pace seen in the real data.
export function replayRule(data, rule, { wallets = null, params = PRESETS.standard } = {}) {
  const flows = deriveFlows(data);
  const n = Math.max(1, wallets === null ? Number(data.documented.wallets || 1) : wallets);
  const names = Array.from({ length: n }, (_, i) => `bundle-${i}`);
  const bps = BigInt(data.documented.bundled_share_bps);
  const allocBps = bps < 2000n ? bps : 2000n;
  const token = makeToken(rule, { ...params, creator: names[0], creator_alloc_bps: allocBps }, 0n);
  if (bps > allocBps) {
    const extra = (token.total_supply * (bps - allocBps)) / 10000n;
    const cost = (token.virtual_near * extra) / (token.pool_tokens - extra) + 1n;
    token.buy(names[0], cost, 0n, 0n);
  }
  const held = token.balanceOf(names[0]);
  const each = held / BigInt(n);
  for (let i = 1; i < n; i++) {
    if (rule === 'loud') token.transferLoud(names[0], names[i], each, 0n);
    else token.transfer(names[0], names[i], each, 0n);
  }
  // Outside liquidity, bought right after the launch window, so that the pool
  // can pay the bundle. The real minutes start from there.
  const t0 = token.launch_ts + BigInt(params.loud_window_ns);
  for (let i = 0; i < 30; i++) token.buy(`crowd-${i}`, CROWD_NEAR / 30n, 0n, t0);
  const seller = makeSeller(rule, token, names, TICK);
  seller.setTarget(0n);

  let intent = 0n;
  let firstIntent = null;
  const series = [];
  flows.forEach((f, i) => {
    const t = t0 + BigInt(i + 1) * TICK;
    if (f.bundleSell > 0) {
      const add = shareToUnits(token, f.bundleSell);
      intent = intent + add > held ? held : intent + add;
      if (firstIntent === null) firstIntent = i;
    }
    seller.setTarget(intent);
    seller.step(t);
    series.push({
      minute: i + 1,
      ts: f.ts,
      bundleIntent: Number((intent * 1_000_000n) / token.total_supply) / 1e6,
      bundleSold: Number((seller.sold * 1_000_000n) / token.total_supply) / 1e6,
    });
  });

  const soldAt = (minutesAfter) => {
    if (firstIntent === null) return null;
    const p = series[Math.min(series.length - 1, firstIntent + minutesAfter)];
    return p.bundleSold;
  };
  const last = series[series.length - 1];
  return {
    rule,
    wallets: n,
    series,
    metrics: {
      bundleIntentTotal: last.bundleIntent,
      bundleSoldTotal: last.bundleSold,
      soldAfter10m: soldAt(10),
      soldAfter60m: soldAt(60),
      intentAfter10m: firstIntent === null ? null : series[Math.min(series.length - 1, firstIntent + 10)].bundleIntent,
      intentAfter60m: firstIntent === null ? null : series[Math.min(series.length - 1, firstIntent + 60)].bundleIntent,
    },
  };
}

// Schedule replay

const bpsToUnits = (token, bps) => (token.total_supply * BigInt(Math.round(bps * 1e4))) / 100_000_000n;
const shareOf = (units, whole) => Number((units * 100_000_000n) / whole) / 1e8;

// The most a LOUD token can have let out by a given minute, as a share of
// supply. The cap starts empty at launch and refills evenly.
export function capBound(minutes, params = PRESETS.standard) {
  return (Number(params.cap_bps) / 10000) * ((minutes * 60) / Number(BigInt(params.cap_window_ns) / SEC));
}

// What happened on chain: the share of supply sold before a minute mark.
export function measuredCumulative(data, minutes) {
  let bps = 0;
  for (const r of data.aggregated_by_minute) if (r.minute < minutes) bps += r.share_of_supply_bps;
  return bps / 10000;
}

// Feeds the measured schedule to one rule as the selling the bundle wants.
// The bundle buys its whole share at launch, which makes it loud supply under
// LOUD, and splits it evenly across its wallets. Minute m of the schedule is
// wanted from the end of minute m, so the point at minute N covers the same
// sales as the on-chain figure for N minutes.
export function replaySchedule(data, rule, { wallets = null, params = PRESETS.standard } = {}) {
  validateSchedule(data);
  const n = Math.max(1, wallets === null ? data.bundle.wallets.length : wallets);
  const names = Array.from({ length: n }, (_, i) => `bundle-${i}`);
  const token = makeToken(rule, { ...params, creator: 'creator', creator_alloc_bps: 0n }, 0n);
  const byMinute = new Map(data.aggregated_by_minute.map((r) => [r.minute, bpsToUnits(token, r.share_of_supply_bps)]));
  let total = 0n;
  for (const v of byMinute.values()) total += v;
  const cost = (token.virtual_near * total) / (token.pool_tokens - total) + 1n;
  token.buy(names[0], cost, 0n, 0n);
  const each = token.balanceOf(names[0]) / BigInt(n);
  for (let i = 1; i < n; i++) {
    if (rule === 'loud') token.transferLoud(names[0], names[i], each, 0n);
    else token.transfer(names[0], names[i], each, 0n);
  }
  for (let i = 0; i < 30; i++) token.buy(`crowd-${i}`, CROWD_NEAR / 30n, 0n, 0n);
  const seller = makeSeller(rule, token, names, TICK);
  seller.setTarget(0n);

  const dust = token.total_supply / 1_000_000n;
  const lastWanted = data.aggregated_by_minute[data.aggregated_by_minute.length - 1].minute + 1;
  const runAtLeast = Math.max(lastWanted, CHECKPOINTS[CHECKPOINTS.length - 1]);
  const series = [];
  let wanted = 0n;
  let firstSale = null;
  let finished = null;
  for (let m = 0; m < MAX_MINUTES; m++) {
    wanted += byMinute.get(m) || 0n;
    seller.setTarget(wanted);
    seller.step(BigInt(m + 1) * TICK);
    if (firstSale === null && seller.sold > 0n) firstSale = m + 1;
    if (finished === null && seller.sold + dust >= total) finished = m + 1;
    series.push({ minute: m + 1, wanted: shareOf(wanted, token.total_supply), sold: shareOf(seller.sold, token.total_supply) });
    if (finished !== null && m + 1 >= runAtLeast) break;
  }
  const firstShout = rule === 'loud' && seller.first_shout_at !== null ? Number(seller.first_shout_at / TICK) : null;
  const bundle = shareOf(total, token.total_supply);
  return {
    rule,
    wallets: n,
    bundle,
    series,
    checkpoints: CHECKPOINTS.map((minutes) => {
      const sold = series[Math.min(series.length, minutes) - 1].sold;
      return { minutes, sold, ofBundle: sold / bundle };
    }),
    firstShoutMinute: firstShout,
    firstSaleMinute: firstSale,
    noticeMinutes: firstShout === null || firstSale === null ? null : firstSale - firstShout,
    finishedMinute: finished,
  };
}

export function replayScheduleAll(data, opts = {}) {
  validateSchedule(data);
  const bundle = measuredCumulative(data, Infinity);
  const windowSeconds = Number(BigInt((opts.params || PRESETS.standard).loud_window_ns) / SEC);
  return {
    label: data.label,
    measured: {
      bundle,
      wallets: data.bundle.wallets.length,
      checkpoints: CHECKPOINTS.map((minutes) => {
        const sold = measuredCumulative(data, minutes);
        return { minutes, sold, ofBundle: sold / bundle };
      }),
      firstSellSeconds: data.bundle.first_sell_s,
      lastSellSeconds: data.bundle.last_sell_s,
      lastBuySeconds: data.bundle.last_buy_s,
      windowSeconds,
      boughtInsideWindow: data.bundle.last_buy_s < windowSeconds,
    },
    rules: RULES.map((rule) => replaySchedule(data, rule, opts)),
  };
}

export function replayData(data) {
  return data.kind === 'sell_schedule' ? replayScheduleAll(data) : replayAll(data);
}

export function replayAll(data) {
  const closes = data.candles.map((c) => c[4]);
  const peak = Math.max(...closes);
  return {
    label: data.label,
    real: {
      candles: data.candles.length,
      firstTs: data.candles[0][0],
      lastTs: data.candles[data.candles.length - 1][0],
      firstClose: closes[0],
      peakClose: peak,
      lastClose: closes[closes.length - 1],
      maxDrop1h: maxDropWithin(closes, 60),
      volumeUsd: data.candles.reduce((s, c) => s + c[5], 0),
    },
    rules: RULES.map((rule) => replayRule(data, rule)),
  };
}

// Report

export const pct = (x, d = 2) => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(d)}%`);
const iso = (ts) => new Date(ts * 1000).toISOString().replace('.000Z', 'Z');
const whole = (x) => Math.round(x).toLocaleString('en-US');

export function markLabel(minutes) {
  return minutes < 120 ? `${minutes} min` : `${minutes / 60} h`;
}

// "17.7 min" up to two hours, then "158.9 h (6.6 days)".
export function spanLabel(minutes) {
  if (minutes === null || minutes === undefined) return `more than ${MAX_MINUTES / 1440} days`;
  if (minutes < 120) return `${Number(minutes.toFixed(1))} min`;
  const hours = `${(minutes / 60).toFixed(1)} h`;
  return minutes < 2880 ? hours : `${hours} (${(minutes / 1440).toFixed(1)} days)`;
}

const RULE_NAMES = { naive: 'no rule', per_wallet: 'per-wallet limit', loud: 'LOUD' };

function renderCandles(out, { file, data, result }) {
  const r = result.real;
  out.push(`## ${data.label}`);
  out.push('');
  out.push('### Real data');
  out.push('');
  out.push(`- Pool \`${data.pool}\` on ${data.network}, token \`${data.token || 'n/a'}\`. File \`sim/replay-data/${file}\`.`);
  out.push(`- Source: ${data.source.provider}, fetched ${data.source.fetched_at}. Request URLs are stored in the file.`);
  out.push(`- ${r.candles} one-minute candles from ${iso(r.firstTs)} to ${iso(r.lastTs)}, USD volume ${whole(r.volumeUsd)}.`);
  out.push(`- Close: first ${r.firstClose}, peak ${r.peakClose}, last ${r.lastClose}. Largest fall within 60 minutes: ${pct(r.maxDrop1h, 1)}.`);
  out.push(`- From the public report (${data.documented.source_url}): the bundle held ${pct(data.documented.bundled_share_bps / 10000, 1)} of supply in ${data.documented.wallets} wallets.`);
  out.push('');
  out.push('### Model');
  out.push('');
  out.push('Everything in this table is model output. The bundle tries to sell at the pace of the real selling volume; each rule decides how much of that gets through.');
  out.push('');
  out.push('| rule | wallets | bundle wanted to sell in 10 min | sold in 10 min | wanted in 60 min | sold in 60 min | sold by the end |');
  out.push('|---|---|---|---|---|---|---|');
  for (const x of result.rules) {
    const m = x.metrics;
    out.push(`| ${x.rule} | ${x.wallets} | ${pct(m.intentAfter10m)} | ${pct(m.soldAfter10m)} | ${pct(m.intentAfter60m)} | ${pct(m.soldAfter60m)} | ${pct(m.bundleSoldTotal)} of ${pct(m.bundleIntentTotal)} |`);
  }
  out.push('');
  out.push('Shares are of total supply. Times count from the first minute with bundle selling.');
  out.push('');
}

function renderSchedule(out, { file, data, result }) {
  const m = result.measured;
  const [naive, perWallet, loud] = result.rules;
  const cell = (c) => `${pct(c.ofBundle)} (${pct(c.sold)})`;
  out.push(`## ${data.label}`);
  out.push('');
  out.push('### Measured on chain');
  out.push('');
  out.push(`- Token \`${data.token.address}\` on ${data.chain} (${data.token.launchpad}), supply ${whole(data.token.total_supply)}, launched ${data.launch_iso}. File \`sim/replay-data/${file}\`.`);
  for (const s of data.sources) out.push(`- Source: ${s.url} (${s.publisher}). ${s.what_it_states}`);
  if (data.token.address_basis) out.push(`- ${data.token.address_basis}`);
  out.push(`- The bundle: ${m.wallets} ${data.bundle.described_as}. They bought ${pct(m.bundle)} of supply and sold all of it through swaps. ${data.bundle.buy_timing}`);
  out.push(`- First sale ${whole(m.firstSellSeconds)} s after launch, last sale ${whole(m.lastSellSeconds)} s after launch (${spanLabel(m.lastSellSeconds / 60)}).`);
  out.push(`- Collected from: ${data.data_source}`);
  out.push('');
  out.push('### Replayed through the rule engine');
  out.push('');
  out.push('The "on chain" column is measured. The other three columns are model output: the same selling, minute by minute, offered to each rule.');
  out.push('');
  out.push(`| after launch | on chain | ${RULE_NAMES.naive} | ${RULE_NAMES.per_wallet}, ${perWallet.wallets} wallets | ${RULE_NAMES.loud} |`);
  out.push('|---|---|---|---|---|');
  m.checkpoints.forEach((c, i) => {
    out.push(`| ${markLabel(c.minutes)} | ${cell(c)} | ${cell(naive.checkpoints[i])} | ${cell(perWallet.checkpoints[i])} | ${cell(loud.checkpoints[i])} |`);
  });
  out.push(`| all sold after | ${spanLabel(m.lastSellSeconds / 60)} | ${spanLabel(naive.finishedMinute)} | ${spanLabel(perWallet.finishedMinute)} | ${spanLabel(loud.finishedMinute)} |`);
  out.push('');
  out.push('Each cell is the share of the bundle sold, with the share of total supply in brackets.');
  out.push('');
  if (loud.noticeMinutes !== null) {
    out.push(`- Public notice under LOUD: the first shout is at minute ${loud.firstShoutMinute} and the first sale at minute ${loud.firstSaleMinute}. Holders see the exit ${loud.noticeMinutes} minutes before the first unit sells.`);
  }
  out.push(`- Under LOUD the bundle finishes ${spanLabel(loud.finishedMinute)} after launch. On chain it took ${spanLabel(m.lastSellSeconds / 60)}.`);
  out.push(m.boughtInsideWindow
    ? `- The last bundle buy was ${whole(m.lastBuySeconds)} s after launch, inside the ${m.windowSeconds / 60} min launch window of the standard preset. The replay treats the whole bundle as loud supply.`
    : `- The last bundle buy was ${whole(m.lastBuySeconds)} s after launch, after the ${m.windowSeconds / 60} min launch window of the standard preset. Tokens bought that late would be quiet. The replay still treats the whole bundle as loud supply, which flatters LOUD.`);
  out.push('');
}

export function renderReplay(entries) {
  const out = [];
  out.push('# LOUD: replay of real launches');
  out.push('');
  out.push('Generated by `node sim/replay.mjs`. Do not edit by hand.');
  out.push('');
  if (entries.length === 0) {
    out.push('## Status: no real data in this folder');
    out.push('');
    out.push('The data folder holds no data file, so there is nothing to replay and this file has no results. `sim/replay-data/README.md` describes the two file formats.');
    out.push('');
    out.push('## What is measured and what is modelled');
    out.push('');
    out.push(scheduleNotes());
    out.push('');
    return out.join('\n');
  }
  const schedules = entries.filter((e) => e.data.kind === 'sell_schedule');
  const candles = entries.filter((e) => e.data.kind !== 'sell_schedule');
  if (schedules.length > 0) {
    out.push(`Measured: the sales of the bundle wallets in ${schedules.length === 1 ? 'one real launch' : `${schedules.length} real launches`}, read from the chain. Modelled: what the three rule sets would have let through if the same wallets had tried to sell the same amounts at the same minutes.`);
    out.push('');
  }
  for (const e of schedules) renderSchedule(out, e);
  for (const e of candles) renderCandles(out, e);
  if (schedules.length > 0) {
    out.push('## What is measured and what is modelled');
    out.push('');
    out.push(scheduleNotes());
    out.push('');
  }
  if (candles.length > 0) {
    out.push(schedules.length > 0 ? '## Candle replays: what is real and what is model' : '## What is real and what is model');
    out.push('');
    out.push(modelNotes());
    out.push('');
  }
  return out.join('\n');
}

function scheduleNotes() {
  return [
    '- Measured: the token, the wallets as the source lists them, the wallet count, and every sale of those wallets. Each sale is placed in its minute after launch as a share of total supply.',
    '- Model: the pool. It is a LOUD-style pool with the SPEC standard preset (100 virtual NEAR, launch window 10 minutes, notice 30 minutes, cap 0.5% of supply per 60 minutes) and 300 NEAR of outside buys at launch. The bundle buys its whole share at launch and splits it evenly across its wallets.',
    '- Model: the bundle wants to sell exactly what it sold on chain, minute by minute. Under LOUD its wallets shout at the first moment they wanted to sell, which is the end of the first minute with a sale on chain, and they go on shouting in batches.',
    '- The replay assumes the bundle bought inside the launch window. A bundle that buys after the launch window holds quiet tokens, and LOUD would not slow it at all.',
    '- The per-wallet limit is 0.5% of supply per sale and one sale per wallet per 60 seconds.',
    '- Nobody else trades in the replay, so it gives no price and no reaction to a shout. It answers one question: with the same selling plan, how much of the bundle each rule lets out, and when.',
    '- The LOUD seller shouts in batches and can leave small gaps. A sharper seller could be a little faster, but never faster than the cap.',
  ].join('\n');
}

function modelNotes() {
  return [
    '- Real: the minute candles (open, high, low, close, USD volume), the total supply, and the bundle share and wallet count quoted from the public report.',
    '- Model: candles do not say who traded. A minute that closes below its open is counted as selling, any other minute as buying. Selling is attributed to the bundle until the documented bundle share is used up, then to other holders. This overstates how early the bundle sold if other holders sold first.',
    '- Model: only the bundle selling is replayed, as shares of supply, into a pool with the SPEC standard preset (100 virtual NEAR, cap 0.5% per 60 minutes, notice 30 minutes) that holds 300 NEAR of outside liquidity. Buying and other selling are not replayed, so the replay produces no price.',
    '- Model: under LOUD the bundle shouts when it first wants to sell, so the first unit leaves one notice period later, and the cap applies from then on.',
    '- Model: a rule can sell less than the bundle wanted even without a limit, when the model pool runs out of NEAR to pay.',
    '- The replay answers one question: with the same selling pressure, how much of the bundle could have left in the first minutes and hours under each rule. It does not say what the real price would have been.',
  ].join('\n');
}

function parseArgs(argv) {
  const a = { fetch: false, network: 'solana', hours: 6, out: HERE, data: DATA_DIR };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--fetch') a.fetch = true;
    else if (k === '--network') a.network = argv[++i];
    else if (k === '--pool') a.pool = argv[++i];
    else if (k === '--hours') a.hours = Number(argv[++i]);
    else if (k === '--from') a.from = argv[++i];
    else if (k === '--label') a.label = argv[++i];
    else if (k === '--bundled-bps') a.bundledBps = Number(argv[++i]);
    else if (k === '--wallets') a.wallets = Number(argv[++i]);
    else if (k === '--doc-url') a.docUrl = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--data') a.data = argv[++i];
  }
  return a;
}

export async function main(argv = process.argv.slice(2)) {
  const a = parseArgs(argv);
  if (a.fetch) {
    for (const k of ['pool', 'label', 'bundledBps', 'wallets', 'docUrl']) {
      if (a[k] === undefined) throw new Error('--fetch needs --pool, --label, --bundled-bps, --wallets and --doc-url');
    }
    const data = await fetchData(a);
    mkdirSync(a.data, { recursive: true });
    const file = join(a.data, `${a.network}-${a.pool}.json`);
    writeFileSync(file, JSON.stringify(data, null, 1) + '\n');
    console.log(`saved ${data.candles.length} candles for ${data.token_symbol}`);
    return null;
  }
  const entries = loadDataFiles(a.data).map((e) => ({ ...e, result: replayData(e.data) }));
  mkdirSync(a.out, { recursive: true });
  writeFileSync(join(a.out, 'REPLAY.md'), renderReplay(entries));
  console.log(`wrote REPLAY.md (${entries.length} data set${entries.length === 1 ? '' : 's'})`);
  return entries;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
