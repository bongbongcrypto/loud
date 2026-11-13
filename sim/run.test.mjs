import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runScenario, runAll, toMarkdown, main, QuietSeller, RULE_ROWS, SCENARIOS } from './run.mjs';
import { LoudToken, PRESETS, NEAR, SEC, MIN } from '../web/engine.js';

test('a run reproduces exactly for the same seed and differs for another', () => {
  const a = runScenario({ scenario: 'bundle_dump', rule: 'loud', days: 2, seed: 3 });
  const b = runScenario({ scenario: 'bundle_dump', rule: 'loud', days: 2, seed: 3 });
  const c = runScenario({ scenario: 'bundle_dump', rule: 'loud', days: 2, seed: 4 });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.series, c.series);
});

test('bundle dump: baselines exit at once, loud exits at the cap rate and is announced', () => {
  const run = (rule) => runScenario({ scenario: 'bundle_dump', rule, days: 3, seed: 1 }).metrics;
  const naive = run('naive');
  const perWallet = run('per_wallet');
  const loud = run('loud');
  assert.ok(naive.earlySupplyShare > 0.12 && naive.earlySupplyShare < 0.15);
  assert.equal(loud.earlySupplyShare, naive.earlySupplyShare);
  assert.ok(naive.earlyExitHours < 0.1);
  assert.ok(perWallet.earlyExitHours < 0.1);
  // 13.6% of supply at 0.5% per hour, minus what the bucket held at the start.
  assert.ok(loud.earlyExitHours > 25 && loud.earlyExitHours < 30, `loud exit took ${loud.earlyExitHours} h`);
  assert.equal(naive.earlyAnnouncedShare, 0);
  assert.equal(loud.earlyAnnouncedShare, 1);
  assert.ok(loud.allSellsAnnouncedShare > 0 && loud.allSellsAnnouncedShare < 1);
  assert.ok(naive.exitAfterSignal < 0.8);
  assert.ok(loud.exitAfterSignal > 0.95);
  assert.ok(loud.worstExitInHalfHour > naive.worstExitInHalfHour);
  assert.ok(loud.maxDrop1h < naive.maxDrop1h);
});

test('calm launch: early supply never sells under any rule', () => {
  const result = runAll({ days: 2, seeds: [1], scenarios: ['calm'] });
  assert.equal(result.rows.length, RULE_ROWS.length);
  for (const row of result.rows) {
    assert.equal(row.median.earlySoldShare, 0);
    assert.equal(row.median.earlyExitHours, null);
    assert.ok(row.median.finalPrice > 0);
  }
  const md = toMarkdown(result);
  assert.match(md, /Calm launch/);
  assert.match(md, /model output, not market data/);
});

test('main writes results.json and RESULTS.md', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loud-sim-'));
  try {
    const log = console.log;
    console.log = () => {};
    try {
      main(['--days', '2', '--seeds', '1', '--out', dir]);
    } finally {
      console.log = log;
    }
    const json = JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8'));
    assert.equal(json.rows.length, RULE_ROWS.length * Object.keys(SCENARIOS).length);
    const md = readFileSync(join(dir, 'RESULTS.md'), 'utf8');
    assert.match(md, /standard preset/);
    assert.ok(!md.includes('undefined') && !md.includes('NaN'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a quiet seller the pool cannot pay in full keeps its remainder and sells it later', () => {
  const token = new LoudToken({ ...PRESETS.standard, cap_bps: 1000n, cap_window_ns: MIN, notice_ns: 30n * SEC }, 0n);
  const creator = PRESETS.standard.creator;
  const have = token.buy('holder', NEAR / 100n, 0n, 10n * MIN);
  // The unbacked creator allocation takes about half of the pool's NEAR.
  const id = token.shout(creator, have / 2n, 10n * MIN);
  token.leave(creator, id, 0n, 10n * MIN + 30n * SEC);

  const s = new QuietSeller(token, 'holder');
  const first = s.step(11n * MIN);
  assert.ok(first > 0n && first < have, 'only part of the balance is payable');
  assert.equal(s.holdings(), have - first);
  // Nothing more is payable yet: the step sells nothing and does not throw.
  assert.equal(s.step(12n * MIN), 0n);
  assert.equal(s.holdings(), have - first);
  // A new buyer brings NEAR; the queued remainder sells on the next step.
  token.buy('buyer', NEAR, 0n, 13n * MIN);
  assert.equal(s.step(14n * MIN), have - first);
  assert.equal(s.holdings(), 0n);
  assert.equal(s.sold, have);
});
