import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeRng, PRESETS, SEC } from '../web/engine.js';
import {
  validateData, deriveFlows, replayRule, replayAll, renderReplay, loadDataFiles, main,
  replaySchedule, replayScheduleAll, replayData, measuredCumulative, capBound, CHECKPOINTS, pct, spanLabel,
} from './replay.mjs';

// SYNTHETIC candles, generated here only to exercise the code. Not market data;
// never written into the repository or into REPLAY.md.
function syntheticData() {
  const rng = makeRng(7);
  const candles = [];
  let price = 0.001;
  for (let i = 0; i < 240; i++) {
    const open = price;
    const up = i < 40 ? rng() < 0.8 : rng() < 0.3;
    price = open * (up ? 1 + rng() * 0.05 : 1 - rng() * 0.05);
    const volume = (i >= 40 && i < 70 ? 400000 : 30000) * (0.5 + rng());
    candles.push([1700000000 + i * 60, open, Math.max(open, price), Math.min(open, price), price, volume]);
  }
  return {
    kind: 'ohlcv_minute',
    label: 'SYNTHETIC test fixture',
    network: 'test',
    pool: 'synthetic',
    total_supply: 1e9,
    documented: { bundled_share_bps: 3000, wallets: 40, source_url: 'none (synthetic)' },
    source: { provider: 'generated in the test', urls: [], fetched_at: 'n/a' },
    candles,
  };
}

test('loader rejects malformed data', () => {
  const d = syntheticData();
  assert.doesNotThrow(() => validateData(d));
  assert.throws(() => validateData({ ...d, candles: [] }), /no candles/);
  assert.throws(() => validateData({ ...d, candles: [d.candles[1], d.candles[0]] }), /ascending/);
  assert.throws(() => validateData({ ...d, candles: [[1, 2, 3], [2, 3, 4]] }), /candle is not/);
  assert.throws(() => validateData({ ...d, documented: { bundled_share_bps: 0 } }), /bundled_share_bps/);
  const { label, ...rest } = d;
  assert.throws(() => validateData(rest), /missing "label"/);
});

test('flows: bundle selling never exceeds the documented share', () => {
  const flows = deriveFlows(syntheticData());
  const total = flows.reduce((s, f) => s + f.bundleSell, 0);
  assert.ok(total > 0.29 && total <= 0.3 + 1e-12, `bundle sold ${total}`);
  for (const f of flows) assert.ok(f.buy === 0 || f.bundleSell + f.otherSell === 0);
});

test('replay: baselines pass the selling through, loud holds it to the cap', () => {
  const data = syntheticData();
  const result = replayAll(data);
  const [naive, perWallet, loud] = result.rules;
  assert.equal(naive.rule, 'naive');
  assert.ok(Math.abs(naive.metrics.soldAfter10m - naive.metrics.intentAfter10m) < 1e-6);
  assert.ok(Math.abs(perWallet.metrics.soldAfter60m - naive.metrics.soldAfter60m) < 1e-6);
  // Notice is 30 minutes, so nothing leaves in the first 10.
  assert.equal(loud.metrics.soldAfter10m, 0);
  // After 60 minutes at most the bucket at the first leave plus half an hour of
  // refill can be gone: well under 1.5 caps = 0.75% of supply.
  assert.ok(loud.metrics.soldAfter60m > 0 && loud.metrics.soldAfter60m <= 0.0075);
  assert.ok(loud.metrics.soldAfter60m < naive.metrics.soldAfter60m / 5);
  for (let i = 0; i < loud.series.length; i++) {
    assert.ok(loud.series[i].bundleSold <= naive.series[i].bundleSold + 1e-9);
    assert.ok(loud.series[i].bundleSold <= loud.series[i].bundleIntent + 1e-9);
  }
});

test('replay: under loud the wallet count does not matter', () => {
  const data = syntheticData();
  const one = replayRule(data, 'loud', { wallets: 1 });
  const many = replayRule(data, 'loud', { wallets: 40 });
  for (let i = 0; i < one.series.length; i++) {
    assert.ok(Math.abs(one.series[i].bundleSold - many.series[i].bundleSold) < 2e-6);
  }
  const pwOne = replayRule(data, 'per_wallet', { wallets: 1 });
  const pwMany = replayRule(data, 'per_wallet', { wallets: 40 });
  assert.ok(pwOne.metrics.soldAfter10m < pwMany.metrics.soldAfter10m);
});

test('report: says plainly when there is no real data, renders a table when there is', async () => {
  const empty = renderReplay([]);
  assert.match(empty, /no real data/i);
  assert.ok(!/\| naive \|/.test(empty));
  const data = syntheticData();
  const md = renderReplay([{ file: 'x.json', data, result: replayAll(data) }]);
  assert.match(md, /\| loud \| 40 \|/);
  assert.ok(!md.includes('undefined') && !md.includes('NaN'));

  const dir = mkdtempSync(join(tmpdir(), 'loud-replay-'));
  try {
    writeFileSync(join(dir, 'fixture.json'), JSON.stringify(data));
    assert.equal(loadDataFiles(dir).length, 1);
    const log = console.log;
    console.log = () => {};
    try {
      await main(['--data', dir, '--out', dir]);
    } finally {
      console.log = log;
    }
    assert.match(readFileSync(join(dir, 'REPLAY.md'), 'utf8'), /SYNTHETIC test fixture/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Schedule replay: measured sales of bundle wallets, minute by minute.

// SYNTHETIC schedule, made up here only to exercise the code.
function syntheticSchedule() {
  return {
    kind: 'sell_schedule',
    label: 'SYNTHETIC schedule fixture',
    chain: 'test',
    token: { address: 'synthetic', launchpad: 'none', total_supply: 1e9 },
    launch_ts: 1700000000,
    launch_iso: '2023-11-14T22:13:20Z',
    sources: [{ url: 'https://example.invalid/none', publisher: 'generated in the test', what_it_states: 'Nothing. Synthetic.' }],
    bundle: {
      described_as: 'synthetic wallets',
      wallets: ['w0', 'w1', 'w2', 'w3', 'w4'],
      buy_timing: 'Synthetic.',
      last_buy_s: 0,
      first_sell_s: 125,
      last_sell_s: 419,
    },
    aggregated_by_minute: [
      { minute: 2, share_of_supply_bps: 300 },
      { minute: 3, share_of_supply_bps: 1200.5 },
      { minute: 4, share_of_supply_bps: 700 },
      { minute: 6, share_of_supply_bps: 299.5 },
    ],
    data_source: 'generated in the test',
  };
}

const realCase = (name) => JSON.parse(readFileSync(new URL(`./replay-data/${name}`, import.meta.url), 'utf8'));
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

test('schedule loader rejects malformed data', () => {
  const d = syntheticSchedule();
  assert.doesNotThrow(() => validateData(d));
  assert.throws(() => validateData({ ...d, aggregated_by_minute: [] }), /empty/);
  assert.throws(() => validateData({ ...d, aggregated_by_minute: [{ minute: 3, share_of_supply_bps: 1 }, { minute: 2, share_of_supply_bps: 1 }] }), /ascending/);
  assert.throws(() => validateData({ ...d, aggregated_by_minute: [{ minute: 0, share_of_supply_bps: 10001 }] }), /whole supply/);
  assert.throws(() => validateData({ ...d, sources: [{ url: 'none' }] }), /https/);
  assert.throws(() => validateData({ ...d, bundle: { ...d.bundle, wallets: [] } }), /wallets/);
  const { sources, ...rest } = d;
  assert.throws(() => validateData(rest), /missing "sources"/);
});

test('schedule in, cumulative out: with no rule the replay returns the schedule', () => {
  const d = syntheticSchedule();
  assert.ok(near(measuredCumulative(d, 2), 0));
  assert.ok(near(measuredCumulative(d, 3), 0.03));
  assert.ok(near(measuredCumulative(d, 5), 0.22005));
  assert.ok(near(measuredCumulative(d, Infinity), 0.25));
  const result = replayScheduleAll(d);
  const [naive] = result.rules;
  assert.equal(naive.rule, 'naive');
  assert.equal(naive.wallets, 5);
  assert.ok(near(naive.bundle, 0.25));
  // Every minute, and every reported mark, is the measured cumulative.
  for (const p of naive.series) assert.ok(near(p.sold, measuredCumulative(d, p.minute)), `minute ${p.minute}`);
  result.measured.checkpoints.forEach((c, i) => {
    assert.equal(naive.checkpoints[i].minutes, CHECKPOINTS[i]);
    assert.ok(near(naive.checkpoints[i].sold, c.sold));
    assert.ok(near(naive.checkpoints[i].ofBundle, c.ofBundle));
  });
  assert.equal(naive.firstSaleMinute, 3);
  assert.equal(naive.finishedMinute, 7);
  assert.equal(naive.noticeMinutes, null);
});

test('real cases: with no rule the replay gives back what happened on chain', () => {
  for (const name of ['case-1.json', 'case-2.json']) {
    const d = realCase(name);
    const result = replayScheduleAll(d);
    const [naive] = result.rules;
    assert.equal(naive.wallets, d.bundle.wallets_reported);
    for (const p of naive.series) assert.ok(near(p.sold, measuredCumulative(d, p.minute)), `${name} minute ${p.minute}`);
    assert.equal(naive.finishedMinute, Math.floor(d.bundle.last_sell_s / 60) + 1);
  }
});

test('schedule replay: no rule ever sells more than the bundle wanted', () => {
  for (const d of [syntheticSchedule(), realCase('case-1.json'), realCase('case-2.json')]) {
    for (const x of replayScheduleAll(d).rules) {
      let last = 0;
      for (const p of x.series) {
        assert.ok(p.sold <= p.wanted + 1e-9, `${x.rule} minute ${p.minute}: sold ${p.sold} of ${p.wanted} wanted`);
        assert.ok(p.wanted <= x.bundle + 1e-9);
        assert.ok(near(p.wanted, measuredCumulative(d, p.minute)));
        assert.ok(p.sold >= last);
        last = p.sold;
      }
      assert.ok(x.finishedMinute !== null, `${x.rule} finishes`);
      assert.ok(near(x.series[x.series.length - 1].sold, x.bundle, 2e-6));
    }
  }
});

test('schedule replay: LOUD never sells past the cap, and nothing sells before the notice ends', () => {
  const noticeMinutes = Number(PRESETS.standard.notice_ns / (60n * SEC));
  for (const d of [syntheticSchedule(), realCase('case-1.json'), realCase('case-2.json')]) {
    const loud = replaySchedule(d, 'loud');
    const firstWanted = d.aggregated_by_minute[0].minute + 1;
    assert.equal(loud.firstShoutMinute, firstWanted);
    assert.equal(loud.firstSaleMinute, firstWanted + noticeMinutes);
    assert.equal(loud.noticeMinutes, noticeMinutes);
    for (const p of loud.series) {
      assert.ok(p.sold <= capBound(p.minute) + 1e-9, `minute ${p.minute}: ${p.sold} above the cap bound ${capBound(p.minute)}`);
      if (p.minute < loud.firstSaleMinute) assert.equal(p.sold, 0);
    }
    // 0.5% of supply per 60 minutes, so 12% after 24 hours at the very most.
    assert.ok(near(capBound(60), 0.005) && near(capBound(1440), 0.12));
    // The whole bundle cannot be out sooner than the cap allows.
    assert.ok(loud.finishedMinute >= (loud.bundle / 0.005) * 60 - 1);
  }
});

test('schedule replay: under LOUD the wallet count does not matter, under a per-wallet limit it does', () => {
  const d = realCase('case-1.json');
  const one = replaySchedule(d, 'loud', { wallets: 1 });
  const four = replaySchedule(d, 'loud');
  const many = replaySchedule(d, 'loud', { wallets: 40 });
  assert.equal(four.wallets, 4);
  for (let i = 0; i < 1440; i++) {
    assert.ok(near(one.series[i].sold, four.series[i].sold, 2e-6));
    assert.ok(near(one.series[i].sold, many.series[i].sold, 2e-6));
  }
  const pwOne = replaySchedule(d, 'per_wallet', { wallets: 1 });
  const pwFour = replaySchedule(d, 'per_wallet');
  assert.ok(pwOne.checkpoints[2].sold < pwFour.checkpoints[2].sold);
  assert.ok(pwOne.finishedMinute > pwFour.finishedMinute);
});

test('case files: the schedule is the sum of the listed sales and matches the stated totals', () => {
  for (const name of ['case-1.json', 'case-2.json']) {
    const d = realCase(name);
    const supply = d.token.total_supply;
    assert.equal(d.kind, 'sell_schedule');
    assert.equal(d.bundle.wallets.length, d.bundle.wallets_reported);
    assert.deepEqual(Object.keys(d.per_wallet), d.bundle.wallets);
    // Sales are in time order and belong to listed wallets.
    const byMinute = new Map();
    const byWallet = new Map();
    let last = -1;
    let total = 0;
    for (const [seconds, wallet, tokens] of d.sells) {
      assert.ok(seconds >= last && wallet >= 0 && wallet < d.bundle.wallets.length && tokens > 0);
      last = seconds;
      total += tokens;
      byMinute.set(Math.floor(seconds / 60), (byMinute.get(Math.floor(seconds / 60)) || 0) + tokens);
      byWallet.set(wallet, (byWallet.get(wallet) || 0) + tokens);
    }
    assert.equal(d.sells[0][0], d.bundle.first_sell_s);
    assert.equal(last, d.bundle.last_sell_s);
    // Everything bought was sold, in total and wallet by wallet.
    assert.ok(near(total, d.bundle.tokens_sold, 0.01) && near(total, d.bundle.tokens_bought, 0.02));
    d.bundle.wallets.forEach((w, i) => {
      const p = d.per_wallet[w];
      assert.ok(near(byWallet.get(i) || 0, p.sold, 0.01), `${w} sold`);
    });
    // The minute schedule and the cumulative table are the same sales.
    assert.equal(d.aggregated_by_minute.length, byMinute.size);
    for (const r of d.aggregated_by_minute) assert.ok(near(r.share_of_supply_bps, (byMinute.get(r.minute) / supply) * 1e4, 1e-4));
    assert.ok(near(measuredCumulative(d, Infinity) * 1e4, d.bundle.share_bps_measured, 0.01));
    assert.ok(Math.abs(d.bundle.share_bps_measured - d.bundle.share_bps_reported) < 15);
    const marks = { '1m': 1, '5m': 5, '10m': 10, '30m': 30, '60m': 60, '6h': 360, '24h': 1440 };
    for (const [key, minutes] of Object.entries(marks)) {
      assert.ok(near(measuredCumulative(d, minutes) * 1e4, d.cumulative[key].supply_bps, 0.01), `${name} ${key}`);
    }
    // Bought inside the standard launch window.
    assert.ok(d.bundle.last_buy_s < Number(PRESETS.standard.loud_window_ns / SEC));
  }
});

test('REPLAY.md in the repository is what the data files produce', () => {
  const entries = loadDataFiles().map((e) => ({ ...e, result: replayData(e.data) }));
  assert.deepEqual(entries.map((e) => e.file), ['case-1.json', 'case-2.json']);
  const md = renderReplay(entries);
  assert.equal(readFileSync(new URL('./REPLAY.md', import.meta.url), 'utf8'), md);
  assert.ok(!md.includes('undefined') && !md.includes('NaN') && !md.includes('n/a'));
  for (const e of entries) for (const s of e.data.sources) assert.ok(md.includes(s.url));
  assert.match(md, /The "on chain" column is measured/);
});

test('README: the replay table carries the numbers of the replay', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const at = readme.indexOf('## Replay of two real bundle dumps');
  assert.ok(at > readme.indexOf('## Simulation') && at < readme.indexOf('## Limits'));
  const section = readme.slice(at, readme.indexOf('\n## ', at + 1));
  const at10 = CHECKPOINTS.indexOf(10);
  const at60 = CHECKPOINTS.indexOf(60);
  for (const name of ['case-1.json', 'case-2.json']) {
    const d = realCase(name);
    const r = replayScheduleAll(d);
    const loud = r.rules[2];
    const want = [
      d.token.address,
      d.sources[0].url,
      pct(r.measured.bundle),
      `| ${pct(r.measured.checkpoints[at10].ofBundle)} | ${pct(r.measured.checkpoints[at60].ofBundle)} | ${spanLabel(r.measured.lastSellSeconds / 60)} |`,
      `| ${pct(loud.checkpoints[at10].ofBundle)} | ${pct(loud.checkpoints[at60].ofBundle)} | ${spanLabel(loud.finishedMinute)} |`,
    ];
    for (const text of want) assert.ok(section.includes(text), `README replay section lacks "${text}"`);
    assert.ok(section.includes(`${loud.noticeMinutes} minutes`));
  }
  assert.ok(!/not tested against real market data/i.test(readme));
});
