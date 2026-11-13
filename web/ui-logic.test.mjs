import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PRESETS, UNIT, NEAR, MIN, HOUR } from './engine.js';
import * as L from './ui-logic.js';

const read = (name) => readFileSync(new URL(name, import.meta.url), 'utf8');

// ---- formatting

test('parseDecimal: strings to base units without floats', () => {
  assert.equal(L.parseDecimal('10', 24), 10n * NEAR);
  assert.equal(L.parseDecimal('0.001', 24), 10n ** 21n);
  assert.equal(L.parseDecimal('1,000,000', 18), 1_000_000n * UNIT);
  assert.equal(L.parseDecimal('86363636.363636363636363636', 18), 86363636363636363636363636n);
  assert.equal(L.parseDecimal('0.1', 18) + L.parseDecimal('0.2', 18), L.parseDecimal('0.3', 18));
  for (const bad of ['', 'abc', '-1', '1e5', '1.2.3', '.5']) assert.throws(() => L.parseDecimal(bad, 18));
  assert.throws(() => L.parseDecimal('0.1234567890123456789', 18), /decimal places/);
});

test('formatters', () => {
  assert.equal(L.fmtTokens(1_234_567n * UNIT), '1,234,567');
  assert.equal(L.fmtTokens(UNIT / 2n), '0');
  assert.equal(L.fmtNear(317_500_000_000_000_000_000_000n), '0.3175');
  assert.equal(L.tokensForInput(5n * UNIT + UNIT / 4n), '5.25');
  assert.equal(L.fmtCompact(5_000_000n * UNIT), '5.00M');
  assert.equal(L.fmtCompact(86_363_636n * UNIT), '86.4M');
  assert.equal(L.fmtCompact(250_000n * UNIT), '250K');
  assert.equal(L.fmtBps(50), '0.5%');
  assert.equal(L.fmtBps(500n), '5%');
  assert.equal(L.fmtDuration(45), '45 s');
  assert.equal(L.fmtDuration(600), '10 min');
  assert.equal(L.fmtDuration(5400), '1 h 30 min');
  assert.equal(L.fmtSinceLaunch(41n * MIN), 'T+0:41');
  assert.equal(L.fmtSinceLaunch(10n * HOUR + 5n * MIN), 'T+10:05');
  assert.equal(L.fmtUtcTime(1_700_000_000_000_000_000n), '22:13:20');
  assert.equal(L.shortAccount('w01.loud-abcdefghijklmnop.testnet', 16).length, 16);
});

test('links: only https and well-formed ids become links', () => {
  assert.equal(L.safeUrl('https://testnet.nearblocks.io/txns/abc'), 'https://testnet.nearblocks.io/txns/abc');
  assert.equal(L.safeUrl('javascript:alert(1)'), null);
  assert.equal(L.safeUrl('http://example.com'), null);
  assert.equal(L.explorerTx('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin'), 'https://testnet.nearblocks.io/txns/9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin');
  assert.equal(L.explorerTx('not a hash"><script>'), null);
  assert.equal(L.explorerAccount('t.loud-ab12.testnet'), 'https://testnet.nearblocks.io/address/t.loud-ab12.testnet');
  assert.equal(L.explorerAccount('Bad Account'), null);
  assert.equal(L.repoFromLocation('someone.github.io', '/loud/'), 'https://github.com/someone/loud');
  assert.equal(L.repoFromLocation('localhost', '/'), null);
});

// ---- static page text matches the engine preset

test('index.html states the SPEC claim and the standard preset values', () => {
  const html = read('./index.html');
  assert.ok(html.includes('LOUD limits how fast early supply can be sold on its defined path, no matter how many wallets it is split across.'));
  assert.ok(html.includes('It does not prevent fraud.'));
  assert.ok(html.includes('Built at NEAR HACKATHON. Testnet only. Unaudited.'));
  const d = L.paramDisplay(PRESETS.standard);
  assert.deepEqual(d, {
    total_supply: '1,000,000,000', creator_alloc: '5%', virtual_near: '100 NEAR',
    loud_window: '10 min', notice: '30 min', exit_window: '60 min', cap: '0.5% per 60 min',
  });
  const table = html.slice(html.indexOf('id="params-table"'), html.indexOf('</table>', html.indexOf('id="params-table"')));
  for (const value of Object.values(d)) assert.ok(table.includes(`<td>${value}</td>`), `parameter table lacks ${value}`);
  // The rule text uses the same notice, exit window and cap.
  assert.ok(html.includes(`Notice, ${d.notice}`));
  assert.ok(html.includes(`Leave, within ${d.exit_window}`));
  assert.ok(html.includes('0.5% of supply per 60 min'));
  // The proof note describes the demo preset.
  const demo = L.paramDisplay(PRESETS.demo);
  assert.ok(html.includes(`launch window ${demo.loud_window}, notice ${demo.notice}, exit window ${demo.exit_window}, cap ${demo.cap}`));
  // No wording the claim rules out.
  assert.ok(!/prevents? (rugs?|insider|rug pulls?)/i.test(html));
  assert.ok(!html.includes('—'), 'no em dashes in page copy');
  // No external scripts, styles or fonts.
  assert.ok(!/<(script|link)[^>]+(src|href)="https?:/i.test(html));
  assert.ok(!/@import|url\(\s*["']?https?:/i.test(read('./styles.css')));
});

// ---- split comparison

test('comparison: per-wallet speed depends on the wallet count, LOUD does not', () => {
  const cache = new Map();
  // 20% of supply, 10 wallets: 40 one-wallet sales of 0.5% become 4 rounds.
  const a = L.runComparison({ wallets: 10, shareBps: 2000 }, cache).stats;
  assert.equal(a.naive.sellOutSec, 60);
  assert.equal(a.per_wallet.sellOutSecSingle, 40 * 60);
  assert.equal(a.per_wallet.sellOutSec, 4 * 60);
  assert.equal(a.per_wallet.speedup, 10);
  assert.equal(a.per_wallet.perTxBps, 50);
  assert.equal(a.loud.sellOutSec, null);
  assert.equal(a.loud.firstSaleSec, 31 * 60);
  assert.ok(a.loud.maxDiffUnits <= 10n, `diff ${a.loud.maxDiffUnits}`);
  assert.equal(a.loud.soldAtEnd, a.loud.soldAtEndSingle);
  assert.equal(a.loud.price.dropAfter1Min, 0);
  assert.ok(a.naive.price.dropAfter1Min > 0.5);

  // 5% of supply, 100 wallets: holdings limit the first round, so the multiple is 10, not 100.
  const b = L.runComparison({ wallets: 100, shareBps: 500 }, cache).stats;
  assert.equal(b.per_wallet.sellOutSecSingle, 10 * 60);
  assert.equal(b.per_wallet.sellOutSec, 60);
  assert.equal(b.per_wallet.speedup, 10);
  assert.ok(b.loud.maxDiffUnits <= 100n);

  const text = (s) => L.resultSentences(s).map((x) => x.text).join(' ');
  assert.match(text(a), /1 wallet needed 40 min to sell the whole position, 10 wallets needed 4 min\. Splitting made the sale 10x faster\./);
  assert.match(text(b), /100 wallets needed 1 min\. Splitting made the sale 10x faster\. The run steps one minute/);
  assert.match(text(a), /LOUD: 1 wallet and 10 wallets sold the same amount at every minute\./);
  assert.match(text(a), /Nothing left before minute 31; 15\.4% of the position was out after 6 h\./);
  assert.ok(!/100x/.test(text(a) + text(b)), 'no fixed multiple in the sentences');
  assert.equal(L.resultTable(a).length, 3);
  assert.equal(L.resultTable(a)[1].single, '40 min');
  assert.equal(L.resultTable(a)[2].split, 'more than 6 h');
});

test('comparison: LOUD is the same for 1, 10 and 1000 wallets at every minute', () => {
  const cache = new Map();
  const ten = L.runComparison({ wallets: 10, shareBps: 500 }, cache);
  const thousand = L.runComparison({ wallets: 1000, shareBps: 500 }, cache);
  // One unit of rounding per account at most (SPEC 8.1).
  assert.ok(ten.stats.loud.maxDiffUnits <= 10n, `10 wallets: ${ten.stats.loud.maxDiffUnits}`);
  assert.ok(thousand.stats.loud.maxDiffUnits <= 1000n, `1000 wallets: ${thousand.stats.loud.maxDiffUnits}`);
  assert.ok(thousand.stats.loud.soldAtEnd > 0.5 && thousand.stats.loud.soldAtEnd < 0.7);
  // Per-wallet limits with 1000 wallets behave like no rule.
  assert.equal(thousand.stats.per_wallet.sellOutSec, thousand.stats.naive.sellOutSec);
  // One wallet: no split sentence.
  const one = L.runComparison({ wallets: 1, shareBps: 500 }, cache);
  const s = L.resultSentences(one.stats);
  assert.equal(s.length, 3);
  assert.match(s[1].text, /one wallet needed 10 min/);
  assert.ok(!/faster/.test(s.map((x) => x.text).join(' ')));
});

test('chart helpers', () => {
  const x = L.linear(0, 60, 40, 340);
  assert.equal(x(0), 40);
  assert.equal(x(60), 340);
  assert.equal(x(30), 190);
  assert.equal(L.pathFrom([[0, 0], [1, 1], [1, 1], [2.26, 3]]), 'M0.0,0.0L1.0,1.0L2.3,3.0');
  const series = [{ t: 600, v: 0 }, { t: 660, v: 1 }, { t: 720, v: 2 }];
  assert.deepEqual(L.seriesPoints(series, 'v', 1), [[0, 0], [1, 1]]);
  assert.deepEqual(L.niceTicks(1, 4), [0, 0.25, 0.5, 0.75, 1]);
});

// ---- exits and the board

test('exitStatus covers the five states', () => {
  const ex = L.normalizeExit({ id: '1', owner: 'a.testnet', amount: '10', remaining: '10', shouted_at: '0', ready_at: '100', expires_at: '200' });
  assert.equal(L.exitStatus(ex, 99n), 'NOTICE');
  assert.equal(L.exitStatus(ex, 100n), 'BOARDING');
  assert.equal(L.exitStatus(ex, 200n), 'BOARDING');
  assert.equal(L.exitStatus(ex, 201n), 'EXPIRED');
  assert.equal(L.exitStatus({ ...ex, remaining: 0n, closed: 'left', closed_at: 150n }, 150n), 'LEFT');
  assert.equal(L.exitStatus({ ...ex, closed: 'hushed', closed_at: 150n }, 300n), 'HUSHED');
  assert.equal(L.exitStatus({ ...ex, closed: 'hushed', closed_at: 250n }, 300n), 'EXPIRED');
});

test('board simulation: statuses come from the engine and agree with its state', () => {
  const sim = L.createBoardSim();
  const seen = new Set();
  let guard = 0;
  while (!sim.done && guard++ < 2000) {
    sim.step();
    const all = sim.exits();
    const open = all.filter((e) => e.closed === null);
    // Open exits rebuilt from events are exactly the engine's open exits.
    const engine = sim.token.getExits(0, 100);
    assert.equal(open.length, engine.length);
    for (const e of engine) {
      const mine = open.find((o) => o.id === e.id);
      assert.ok(mine, `exit ${e.id} missing`);
      assert.equal(mine.remaining, e.remaining);
      assert.equal(mine.shouted_at, e.shouted_at);
      assert.equal(mine.ready_at, e.ready_at);
      assert.equal(mine.expires_at, e.expires_at);
    }
    const rows = L.boardRows(all, sim.now, { limit: 9 });
    assert.ok(rows.length <= 9);
    assert.equal(new Set(rows.map((r) => r.id)).size, rows.length);
    for (const r of rows) seen.add(r.status);
  }
  assert.ok(sim.done, 'the simulated early supply leaves completely');
  for (const s of ['NOTICE', 'BOARDING', 'LEFT']) assert.ok(seen.has(s), `never showed ${s}`);
  // Everything that left went through leave: 5% of supply.
  assert.equal(sim.state().total_left, sim.token.getParams().creator_alloc);
});

// ---- sandbox

test('sandbox: the guided path shows the real errors', () => {
  const sb = new L.Sandbox();
  let r = sb.buy('10');
  assert.ok(r.ok);
  assert.match(r.message, /loud/);
  let v = sb.view();
  assert.equal(v.loud, 86363636363636363636363636n);
  assert.equal(v.quiet, 0n);
  assert.ok(v.loudWindowOpen);

  r = sb.sell('1000');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E_NO_QUIET');
  assert.ok(r.message.startsWith('E_NO_QUIET: '));

  r = sb.shout(L.tokensForInput(v.loud));
  assert.ok(r.ok, r.message);
  v = sb.view();
  assert.equal(v.loud, 0n);
  assert.equal(v.escrowed, 86363636363636363636363636n);
  assert.equal(v.rows.length, 1);
  assert.equal(v.rows[0].status, 'NOTICE');
  assert.ok(v.rows[0].canLeave && v.rows[0].canHush);

  r = sb.leave('1');
  assert.equal(r.code, 'E_NOTICE');
  assert.match(r.message, /1800 seconds of notice left/);

  sb.skip(30n * MIN);
  assert.equal(sb.view().rows[0].status, 'BOARDING');
  r = sb.leave('1');
  assert.ok(r.ok);
  assert.match(r.message, /^Partial fill: 2,500,000 LOUD/);
  r = sb.leave('1');
  assert.equal(r.code, 'E_CAP');
  v = sb.view();
  assert.equal(v.capAvailable, 0n);
  assert.match(v.nextRoomText, /^The cap is empty and refills continuously/);
  assert.ok(v.nearOut > 0n);

  sb.skip(61n * MIN);
  assert.equal(sb.view().rows[0].status, 'EXPIRED');
  r = sb.leave('1');
  assert.equal(r.code, 'E_EXPIRED');
  r = sb.hush('1');
  assert.ok(r.ok);
  v = sb.view();
  assert.equal(v.rows[0].status, 'EXPIRED');
  assert.equal(v.rows[0].canLeave, false);
  assert.equal(v.loud, 86363636363636363636363636n - 2_500_000n * UNIT);

  // A buy after the launch window is quiet and sells at once.
  r = sb.buy('1');
  assert.match(r.message, /quiet/);
  v = sb.view();
  r = sb.sell(L.tokensForInput(v.quiet));
  assert.ok(r.ok, r.message);

  // The tag follows the tokens to a second wallet.
  r = sb.splitHalf();
  assert.ok(r.ok, r.message);
  sb.switchAccount();
  v = sb.view();
  assert.equal(v.account, 'you-2.testnet');
  assert.ok(v.loud > 0n);
  assert.equal(v.quiet, 0n);
  assert.equal(sb.sell('1').code, 'E_NO_QUIET');
  // Exits of the other wallet are listed but not actionable.
  sb.switchAccount();
  sb.shout('1000');
  sb.switchAccount();
  const foreign = sb.view().rows.find((x) => x.account === 'you.testnet' && x.status === 'NOTICE');
  assert.ok(foreign && !foreign.canLeave && !foreign.canHush);

  // With everything escrowed there is nothing to send.
  sb.switchAccount();
  const free = sb.view().loud;
  if (free >= 1000n * UNIT) sb.shout(L.tokensForInput(free));
  r = sb.splitHalf();
  assert.equal(r.code, 'INPUT');
  assert.match(r.message, /No free loud balance/);

  // Bad input never reaches the engine.
  r = sb.buy('ten');
  assert.equal(r.code, 'INPUT');
  assert.equal(sb.view().log.length, sb.log.length);
  sb.reset();
  assert.equal(sb.view().log.length, 0);
  assert.equal(sb.view().clock, 'T+0:00');
});

// ---- chain views

const bytes = (obj) => [...new TextEncoder().encode(JSON.stringify(obj))];

test('view calls: request shape, decoding, failover and soft failure', async () => {
  const req = L.viewRequest('t.loud-ab12.testnet', 'get_exits', { from_index: 0, limit: 100 });
  assert.equal(req.method, 'query');
  assert.equal(req.params.request_type, 'call_function');
  assert.equal(req.params.finality, 'final');
  assert.deepEqual(JSON.parse(atob(req.params.args_base64)), { from_index: 0, limit: 100 });
  assert.throws(() => L.viewRequest('Not An Account', 'get_state'));

  assert.deepEqual(L.decodeViewResult({ result: { result: bytes({ a: '1' }) } }), { a: '1' });
  assert.throws(() => L.decodeViewResult({ error: { name: 'HANDLER_ERROR' } }), /RPC error/);
  assert.throws(() => L.decodeViewResult({ result: { error: 'wasm execution failed' } }), /view error/);
  assert.throws(() => L.decodeViewResult({}), /no result/);

  const state = {
    pool_tokens: '1', pool_near: '2', loud_outstanding: String(50_000_000n * UNIT), escrowed: String(3_000_000n * UNIT),
    cap_available: String(1_000_000n * UNIT), cap_units: String(5_000_000n * UNIT), next_room_ts: '0', open_exits: 1,
    total_shouted: '0', total_left: String(2_000_000n * UNIT), shout_count: '20', leave_count: '7',
    now: '1700000000000000000', is_loud_window: false,
  };
  const params = { total_supply: String(10n ** 27n), creator: 'insider.loud-ab12.testnet', cap_bps: 50, cap_window_ns: '600000000000', notice_ns: '60000000000', exit_window_ns: '600000000000' };
  const exits = [{ id: '3', owner: 'w03.loud-ab12.testnet', amount: String(3_000_000n * UNIT), remaining: String(3_000_000n * UNIT), shouted_at: '1699999990000000000', ready_at: '1700000050000000000', expires_at: '1700000650000000000' }];
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push(url);
    if (url.includes('down')) throw new Error('network down');
    const method = JSON.parse(init.body).params.method_name;
    const result = { get_params: params, get_state: state, get_exits: exits }[method];
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: { result: bytes(result) } }) };
  };
  const live = await L.fetchLive(fakeFetch, 't.loud-ab12.testnet', ['https://down.example', 'https://up.example']);
  assert.equal(calls.filter((u) => u.includes('up')).length, 3);
  assert.equal(live.state.cap_units, 5_000_000n * UNIT);
  assert.equal(live.state.is_loud_window, false);
  assert.equal(live.exits[0].id, 3n);
  const rows = L.boardRows(live.exits, live.state.now, { clock: L.fmtUtcTime });
  assert.equal(rows[0].status, 'NOTICE');
  assert.equal(rows[0].ready, '22:14:10');
  assert.equal(rows[0].detail, 'ready in 50 s');
  const facts = Object.fromEntries(L.liveFacts(live));
  assert.equal(facts['Cap room now'], '1,000,000 of 5,000,000 LOUD');
  assert.equal(facts.Cap, '0.5% of supply per 10 min');

  await assert.rejects(L.fetchLive(fakeFetch, 't.loud-ab12.testnet', ['https://down.example']), /no RPC endpoint answered/);
});

// ---- proof view model

const H = (c) => c.repeat(44);

function fixture() {
  const deployment = {
    status: 'ok', network: 'testnet', preset: 'demo',
    token_account: 't.loud-ab12.testnet', root_account: 'loud-ab12.testnet', creator_account: 'insider.loud-ab12.testnet',
    params: {}, onchain_params: {}, deployed_at: '2026-11-14T03:00:00.000Z', deployed_at_ns: '1',
    tx: H('A'), zero_keys: true, access_keys: [], wasm: { bytes: 210000, sha256: 'ab'.repeat(32) }, code_hash: H('B'),
    explorer: { token: 'https://testnet.nearblocks.io/address/t.loud-ab12.testnet', root: null, tx: `https://testnet.nearblocks.io/txns/${H('A')}` },
    run: { repository: 'someone/loud', run_id: '123456', commit: 'abcdef1234567890abcdef1234567890abcdef12' },
    generated_at: '2026-11-14T03:20:00.000Z',
  };
  const leaves = Array.from({ length: 300 }, (_, i) => ({
    hash: i % 3 === 0 ? H('C') : H('D'), account: `w${String((i % 20) + 1).padStart(2, '0')}.loud-ab12.testnet`,
    outcome: i % 3 === 0 ? 'success' : 'failure', error: i % 3 === 0 ? null : 'E_CAP: hourly cap is used up',
    round: Math.floor(i / 20) + 1, exit_id: String((i % 20) + 1), filled: i % 3 === 0 ? String(40_000n * UNIT) : null,
    error_code: i % 3 === 0 ? null : 'E_CAP', block_timestamp: '1700000000000000000',
  }));
  const receipts = {
    status: 'ok', network: 'testnet', token_account: 't.loud-ab12.testnet',
    accounts: { insider: 'insider.loud-ab12.testnet', late: 'late.loud-ab12.testnet', wallets: [] },
    steps: Array.from({ length: 10 }, (_, i) => ({
      n: 10 - i, title: `step ${10 - i}`, ok: true, expect: 'expected', got: 'got',
      txs: 10 - i === 9 ? leaves : [{ hash: H('E'), account: 'insider.loud-ab12.testnet', outcome: 'success', error: null }],
    })),
    split: {
      wallets: 20, cap_units: String(5_000_000n * UNIT), cap_window_ns: '600000000000', bucket_at_start: String(500_000n * UNIT),
      window_start_ns: '1700000000000000000', window_end_ns: '1700000600000000000', measured_until_ns: '1700000630000000000',
      sold_in_window: String(5_400_000n * UNIT), sold_total: String(5_600_000n * UNIT), bound: String(5_750_000n * UNIT),
      attempts: 300, fills: 100, cap_hits: 200, receipts_match_counter: true, pass: true,
    },
    error: null, generated_at: '2026-11-14T03:20:00.000Z',
  };
  return { deployment, receipts };
}

test('proof: the placeholder files render as pending', () => {
  const d = L.deploymentView(JSON.parse(read('./deployment.json')));
  const r = L.receiptsView(JSON.parse(read('./receipts.json')));
  if (d.state === 'pending') {
    assert.equal(d.token, null);
    assert.equal(d.zeroKeys, false);
    assert.match(d.headline, /^Pending/);
  }
  if (r.state === 'pending') {
    assert.match(r.headline, /^Pending/);
    assert.equal(r.split.result, 'PENDING');
  }
  // Missing or broken files are pending too.
  assert.equal(L.deploymentView(null).state, 'pending');
  assert.equal(L.receiptsView(undefined).steps.length, 0);
  assert.equal(L.receiptsView({ status: 'weird', steps: 'x' }).state, 'pending');
});

test('proof: a completed run', () => {
  const { deployment, receipts } = fixture();
  const d = L.deploymentView(deployment);
  assert.equal(d.state, 'ok');
  assert.equal(d.token, 't.loud-ab12.testnet');
  assert.equal(d.zeroKeys, true);
  const byLabel = Object.fromEntries(d.rows.map((x) => [x.label, x]));
  assert.match(byLabel['Access keys on the token account'].value, /^0 access keys/);
  assert.equal(byLabel['Deploy transaction'].href, `https://testnet.nearblocks.io/txns/${H('A')}`);
  assert.equal(byLabel['CI run that produced this'].href, 'https://github.com/someone/loud/actions/runs/123456');
  assert.equal(d.repo, 'someone/loud');

  const r = L.receiptsView(receipts);
  assert.equal(r.state, 'ok');
  assert.deepEqual(r.steps.map((s) => s.n), ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
  assert.ok(r.steps.every((s) => s.result === 'PASS'));
  const nine = r.steps[8];
  assert.equal(nine.txs.length, 300);
  assert.match(nine.txSummary, /300 transactions: 100 succeeded, 200 failed on chain/);
  assert.equal(nine.txs[0].note, 'filled 40,000');
  assert.equal(nine.txs[1].note, 'E_CAP');
  assert.equal(r.split.result, 'PASS');
  assert.equal(r.split.sentence, '20 wallets sold 5,600,000 LOUD in 10 min 30 s. The cap allowed at most 5,750,000 LOUD in that time.');
});

test('proof: a failed run and a key on the account are not shown as passing', () => {
  const { deployment, receipts } = fixture();
  const withKey = L.deploymentView({ ...deployment, status: 'failed', zero_keys: false, access_keys: ['ed25519:abc'] });
  assert.equal(withKey.state, 'failed');
  assert.equal(withKey.zeroKeys, false);
  assert.match(withKey.rows.find((x) => x.label.startsWith('Access keys')).value, /^1 access keys found/);
  // The flag alone is not enough: the key list must be present and empty.
  assert.match(L.deploymentView({ ...deployment, access_keys: null }).headline, /zero-key check is not confirmed/);
  assert.equal(L.deploymentView({ ...deployment, access_keys: null }).zeroKeys, false);
  assert.equal(L.deploymentView({ ...deployment, access_keys: ['ed25519:abc'] }).zeroKeys, false);
  // Hostile strings in the data never become links.
  const bad = L.deploymentView({ ...deployment, tx: '"><img src=x>', explorer: { tx: 'javascript:alert(1)' } });
  assert.equal(bad.rows.find((x) => x.label === 'Deploy transaction').href, null);

  const steps = receipts.steps.map((s) => (s.n === 10 ? { ...s, ok: false, got: 'sold more than the bound' } : s));
  const r = L.receiptsView({ ...receipts, status: 'failed', steps, split: { ...receipts.split, pass: false }, error: 'step 10 failed' });
  assert.equal(r.state, 'failed');
  assert.equal(r.steps[9].result, 'FAIL');
  assert.match(r.headline, /9 of 10 recorded steps passed/);
  assert.equal(r.split.result, 'FAIL');
  assert.equal(r.error, 'step 10 failed');
});
