import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeRng } from '../web/engine.js';
import { validateData, deriveFlows, replayRule, replayAll, renderReplay, loadDataFiles, main } from './replay.mjs';

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
