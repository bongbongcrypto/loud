import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runScenario, runAll, toMarkdown, main, RULE_ROWS, SCENARIOS } from './run.mjs';

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
