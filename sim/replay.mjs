// Replay of a real launch through the three rule sets.
//
//   node sim/replay.mjs
//       reads every data file in sim/replay-data/ and writes sim/REPLAY.md (offline)
//   node sim/replay.mjs --fetch --network solana --pool <pool address> --hours 6 \
//       --label "<name>" --bundled-bps <share of supply held by the bundle> \
//       --wallets <number of bundle wallets> --doc-url <public report>
//       downloads minute candles from the GeckoTerminal public API (no key) into
//       sim/replay-data/. The public API only serves the last 180 days.
//
// What is real and what is model:
//   real   minute open/high/low/close and USD volume of the pool, total supply,
//          and the bundle share and wallet count taken from the cited public report
//   model  the split of volume into buys and sells, which sells belong to the
//          bundle, and the LOUD-style pool the bundle selling is replayed into

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

// ---- loader ----

export function validateData(data) {
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

// ---- model ----

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

// ---- report ----

const pct = (x, d = 2) => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(d)}%`);
const iso = (ts) => new Date(ts * 1000).toISOString().replace('.000Z', 'Z');

export function renderReplay(entries) {
  const out = [];
  out.push('# LOUD: replay of a real launch');
  out.push('');
  out.push('Generated by `node sim/replay.mjs`. Do not edit by hand.');
  out.push('');
  if (entries.length === 0) {
    out.push('## Status: no real data in this repository');
    out.push('');
    out.push('**This file contains no replay results, because no real data set could be obtained without an API key.** No numbers were made up to fill the gap.');
    out.push('');
    out.push('What was tried (see `sim/replay-data/README.md` for the exact requests and answers):');
    out.push('');
    out.push('- GeckoTerminal public API, minute OHLCV: reachable without a key, but it only serves the last 180 days. The first candidate pool tried (HAWK / SOL, created 2024-12-04) is older, and the API answers 401 for it.');
    out.push('- DexPaprika: minute candles and any history beyond 24 hours need an API key.');
    out.push('- DefiLlama coin prices: no history for the tokens tried.');
    out.push('- Public reports on bundled launches inside the last 180 days were found, but none of them both named a token address and documented the sales, so no pool could be matched to a report without guessing.');
    out.push('');
    out.push('What exists instead:');
    out.push('');
    out.push('- The loader and the replay are written and tested (`sim/replay.mjs`, `sim/replay.test.mjs`). The test uses generated candles that are marked as synthetic and never written to this file.');
    out.push('- The download path was run against the live API for a recent pool and returned valid minute candles. That file is not included, because the pool could not be tied to a public report.');
    out.push('');
    out.push('To produce a real replay, pick a launch from the last 180 days whose bundle is described in a public report that names the token, then run:');
    out.push('');
    out.push('```');
    out.push('node sim/replay.mjs --fetch --network solana --pool <pool address> --hours 6 --label "<name>" --bundled-bps <bps> --wallets <n> --doc-url <report url>');
    out.push('node sim/replay.mjs');
    out.push('```');
    out.push('');
    out.push('## What the replay will and will not show');
    out.push('');
    out.push(modelNotes());
    out.push('');
    return out.join('\n');
  }
  for (const { file, data, result } of entries) {
    const r = result.real;
    out.push(`## ${data.label}`);
    out.push('');
    out.push('### Real data');
    out.push('');
    out.push(`- Pool \`${data.pool}\` on ${data.network}, token \`${data.token || 'n/a'}\`. File \`sim/replay-data/${file}\`.`);
    out.push(`- Source: ${data.source.provider}, fetched ${data.source.fetched_at}. Request URLs are stored in the file.`);
    out.push(`- ${r.candles} one-minute candles from ${iso(r.firstTs)} to ${iso(r.lastTs)}, USD volume ${Math.round(r.volumeUsd).toLocaleString('en-US')}.`);
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
  out.push('## What is real and what is model');
  out.push('');
  out.push(modelNotes());
  out.push('');
  return out.join('\n');
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
  const entries = loadDataFiles(a.data).map((e) => ({ ...e, result: replayAll(e.data) }));
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
