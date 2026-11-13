import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PRESETS, UNIT, NEAR, MIN, HOUR } from './engine.js';
import * as L from './ui-logic.js';

const read = (name) => readFileSync(new URL(name, import.meta.url), 'utf8');

// Formatting

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

// Static page text matches the engine preset

test('index.html states the SPEC claim and the standard preset values', () => {
  const html = read('./index.html');
  // The summary carries the claim in the SPEC's words, next to what it does not cover.
  assert.ok(html.includes('<dt>Claim</dt><dd>LOUD limits how fast early supply can be sold on its defined path, no matter how many wallets it is split across. It does not prevent fraud.'));
  assert.ok(html.includes('Built at NEAR HACKATHON. Testnet only. Unaudited.'));
  const d = L.paramDisplay(PRESETS.standard);
  assert.deepEqual(d, {
    total_supply: '1,000,000,000', creator_alloc: '5%', virtual_near: '100 NEAR',
    loud_window: '10 min', notice: '30 min', exit_window: '60 min', cap: '0.5% per 60 min',
  });
  const table = html.slice(html.indexOf('id="params-table"'), html.indexOf('</table>', html.indexOf('id="params-table"')));
  for (const value of Object.values(d)) assert.ok(table.includes(`<td>${value}</td>`), `parameter table lacks ${value}`);
  // The rule text uses the same notice, exit window and cap.
  assert.ok(html.includes(`<b>Wait ${d.notice}</b>`));
  assert.ok(html.includes(`<b>Leave within ${d.exit_window}</b>`));
  assert.ok(html.includes('0.5% of supply per 60 min'));
  // A shout stays locked for the notice plus the exit window.
  const lockMin = Number((PRESETS.standard.notice_ns + PRESETS.standard.exit_window_ns) / MIN);
  assert.ok(html.includes(`the exit expires ${lockMin} min after the shout, and they stay locked until someone calls <code>hush</code>.`));
  assert.ok(html.includes(`There is no penalty beyond gas and the lock, ${lockMin} min in the standard preset.`));
  // The hero is the kicker, the headline and one line on why, nothing else.
  const lede = html.slice(html.indexOf('<section class="lede"'), html.indexOf('</section>', html.indexOf('<section class="lede"')));
  assert.equal((lede.match(/<p[ >]/g) || []).length, 2);
  assert.equal((html.match(/<h1[ >]/g) || []).length, 1);
  // The proof note describes the demo preset.
  const demo = L.paramDisplay(PRESETS.demo);
  assert.ok(html.includes(`launch window ${demo.loud_window}, notice ${demo.notice}, exit window ${demo.exit_window}, cap ${demo.cap}`));
  // No wording the claim rules out.
  assert.ok(!/prevents? (rugs?|insider|rug pulls?)/i.test(html));
  // No external scripts, styles or fonts.
  assert.ok(!/<(script|link)[^>]+(src|href)="https?:/i.test(html));
  assert.ok(!/@import|url\(\s*["']?https?:/i.test(read('./styles.css')));
});

// Split comparison

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

  // 5% of supply, 100 wallets: each wallet holds less than its limit, so the multiple is 10.
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

// Exits and the board

test('exitStatus covers the four states', () => {
  const ex = L.normalizeExit({ id: '1', owner: 'a.testnet', amount: '10', remaining: '10', shouted_at: '0', ready_at: '100', expires_at: '200' });
  assert.equal(L.exitStatus(ex, 99n), 'NOTICE');
  assert.equal(L.exitStatus(ex, 100n), 'BOARDING');
  assert.equal(L.exitStatus(ex, 200n), 'BOARDING');
  assert.equal(L.exitStatus(ex, 201n), 'EXPIRED');
  assert.equal(L.exitStatus({ ...ex, remaining: 0n, closed: 'left', closed_at: 150n }, 150n), 'LEFT');
  // hush only succeeds after expiry, so a hushed exit reads as expired.
  const hushed = { ...ex, closed: 'hushed', closed_at: 250n };
  assert.equal(L.exitStatus(hushed, 300n), 'EXPIRED');
  const rows = L.boardRows([{ ...ex }, { ...hushed, id: 2n }], 300n);
  assert.deepEqual(rows.map((r) => r.detail), ['0.00 locked until hush', '0.00 returned, still loud']);
});

test('board simulation: statuses come from the engine and agree with its state', () => {
  const sim = L.createBoardSim();
  const seen = new Set();
  let sawCut = false;
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
    // The board states its scope: the counts add up and "show all" hides nothing.
    const view = L.boardView(all, sim.now, { limit: 9 });
    assert.deepEqual(view.rows, rows);
    assert.equal(view.total, all.length);
    assert.equal(view.open + view.closed, all.length);
    assert.equal(view.shownOpen + view.shownClosed, rows.length);
    assert.equal(view.cut, rows.length < all.length);
    if (view.cut) {
      assert.equal(L.boardScope(view),
        `Showing ${rows.length} of ${all.length} exits: ${view.shownOpen} of ${view.open} open, ${view.shownClosed} of ${view.closed} closed.`);
      sawCut = true;
    }
    const full = L.boardView(all, sim.now, { limit: 9, showAll: true });
    assert.equal(full.rows.length, all.length);
    assert.equal(full.cut, false);
    if (all.length) assert.match(L.boardScope(full), new RegExp(`^Showing all ${all.length} exits?: `));
  }
  assert.ok(sawCut, 'the simulation never had more exits than rows');
  assert.equal(L.boardScope(L.boardView([], 0n)), '');
  assert.ok(sim.done, 'the simulated early supply leaves completely');
  for (const s of ['NOTICE', 'BOARDING', 'LEFT']) assert.ok(seen.has(s), `never showed ${s}`);
  // Everything that left went through leave: 5% of supply.
  assert.equal(sim.state().total_left, sim.token.getParams().creator_alloc);
});

// Sandbox

test('sandbox: "send half" sends half of the combined balance, quiet first', () => {
  const sb = new L.Sandbox();
  assert.ok(sb.buy('10').ok);
  sb.skip(10n * MIN);
  assert.ok(sb.buy('10').ok);
  let v = sb.view();
  assert.ok(v.loud > 0n && v.quiet > 0n);
  // Here the quiet part is smaller than half, so all quiet and some loud move.
  const half = (v.loud + v.quiet) / 2n;
  assert.ok(v.quiet < half);
  let r = sb.splitHalf();
  assert.ok(r.ok, r.message);
  assert.match(r.message, /The loud tag moved with the tokens\.$/);
  const after = sb.view();
  assert.equal(after.otherLoud + after.otherQuiet, half);
  assert.equal(after.otherQuiet, v.quiet);
  assert.equal(after.otherLoud, half - v.quiet);
  assert.equal(after.loud + after.quiet, v.loud + v.quiet - half);
  assert.equal(after.quiet, 0n);

  // When quiet covers the half, no loud moves and the message says so.
  const sb2 = new L.Sandbox();
  assert.ok(sb2.buy('1').ok);
  sb2.skip(10n * MIN);
  assert.ok(sb2.buy('50').ok);
  v = sb2.view();
  assert.ok(v.quiet > v.loud);
  r = sb2.splitHalf();
  assert.ok(r.ok, r.message);
  assert.match(r.message, /no loud tokens moved/);
  const after2 = sb2.view();
  assert.equal(after2.otherLoud, 0n);
  assert.equal(after2.otherQuiet, (v.loud + v.quiet) / 2n);
  assert.equal(after2.loud, v.loud);
});

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
  assert.deepEqual(v.path, [true, true, true, false, false, false]);

  r = sb.leave('1');
  assert.equal(r.code, 'E_NOTICE');
  assert.match(r.message, /1800 seconds of notice left/);

  // A shout is binding: the owner cannot take it back during the notice
  // or while the exit is ready.
  r = sb.hush('1');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E_NOTICE_BINDING');
  assert.ok(r.message.startsWith('E_NOTICE_BINDING: '));
  // The time in the error is minutes since launch, with no nanosecond count.
  assert.match(r.message, /90 min/);
  assert.doesNotMatch(r.message, /\d{9,}/);
  assert.equal(sb.view().escrowed, 86363636363636363636363636n);
  assert.deepEqual(sb.view().path, [true, true, true, true, false, false]);

  sb.skip(30n * MIN);
  assert.equal(sb.view().rows[0].status, 'BOARDING');
  assert.equal(sb.hush('1').code, 'E_NOTICE_BINDING');
  r = sb.leave('1');
  assert.ok(r.ok);
  assert.match(r.message, /^Partial fill: 2,500,000 LOUD/);
  r = sb.leave('1');
  assert.equal(r.code, 'E_CAP');
  assert.match(r.message, /room returns/);
  assert.doesNotMatch(r.message, /\d{9,}/);
  v = sb.view();
  assert.equal(v.capAvailable, 0n);
  assert.match(v.nextRoomText, /^The cap is empty and refills continuously/);
  assert.ok(v.nearOut > 0n);

  sb.skip(61n * MIN);
  assert.equal(sb.view().rows[0].status, 'EXPIRED');
  r = sb.leave('1');
  assert.equal(r.code, 'E_EXPIRED');
  assert.match(sb.view().rows[0].detail, /locked until hush$/);
  r = sb.hush('1');
  assert.ok(r.ok, r.message);
  v = sb.view();
  assert.equal(v.rows[0].status, 'EXPIRED');
  assert.match(v.rows[0].detail, /returned, still loud$/);
  assert.equal(v.rows[0].canLeave, false);
  assert.deepEqual(v.path, [true, true, true, true, true, true]);
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
  assert.match(r.message, /The loud tag moved with the tokens\.$/);
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
  assert.match(r.message, /No free balance to send/);

  // Bad input never reaches the engine.
  r = sb.buy('ten');
  assert.equal(r.code, 'INPUT');
  assert.equal(sb.view().log.length, sb.log.length);
  sb.reset();
  assert.equal(sb.view().log.length, 0);
  assert.equal(sb.view().clock, 'T+0:00');
});

// Chain views

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
  const pinnedReq = L.viewRequest('t.loud-ab12.testnet', 'get_params', {}, 1, 777);
  assert.equal(pinnedReq.params.block_id, 777);
  assert.equal('finality' in pinnedReq.params, false);
  assert.equal(L.viewBlockHeight({ result: { block_height: 777, result: [] } }), 777);
  assert.equal(L.viewBlockHeight({ result: { result: [] } }), null);

  // A fake node: answers at `tip` unless the request pins a block; `tip` moves
  // after every answer, so unpinned views come from different blocks.
  const mkExit = (i) => ({ id: String(i), owner: `w${i}.loud-ab12.testnet`, amount: String(3_000_000n * UNIT), remaining: String(3_000_000n * UNIT), shouted_at: '1699999990000000000', ready_at: '1700000050000000000', expires_at: '1700000650000000000' });
  const node = ({ list = exits, canPin = true, height = true } = {}) => {
    const calls = [];
    let tip = 500;
    const fetchFn = async (url, init) => {
      if (url.includes('down')) throw new Error('network down');
      const p = JSON.parse(init.body).params;
      calls.push(p);
      if (p.block_id !== undefined && !canPin) return { ok: true, status: 200, json: async () => ({ error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_BLOCK' } } }) };
      const args = JSON.parse(atob(p.args_base64));
      const result = p.method_name === 'get_exits'
        ? list.slice(args.from_index, args.from_index + Math.min(args.limit, 100))
        : { get_params: params, get_state: state }[p.method_name];
      const at = p.block_id ?? tip++;
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: { ...(height ? { block_height: at } : {}), result: bytes(result) } }) };
    };
    return { calls, fetchFn };
  };

  const one = node();
  const fakeFetch = one.fetchFn;
  const live = await L.fetchLive(fakeFetch, 't.loud-ab12.testnet', ['https://down.example', 'https://up.example']);
  // get_state at the final block, then get_params and one page of get_exits pinned to it.
  assert.deepEqual(one.calls.map((p) => [p.method_name, p.block_id ?? p.finality]), [['get_state', 'final'], ['get_params', 500], ['get_exits', 500]]);
  assert.deepEqual(live.block, { pinned: true, height: 500, heights: [500] });
  assert.equal(live.exitsCapped, false);
  assert.match(L.liveSummary(live, 't.loud-ab12.testnet'),
    /^Snapshot of t\.loud-ab12\.testnet at block 500, chain time 2023-11-14 22:13:20 UTC\. get_state, get_params and get_exits were all read at that block\. It was read once, .* does not update on its own\.$/);

  // 250 open exits arrive in three pages, out of id order, and none is dropped.
  const many = Array.from({ length: 250 }, (_, i) => mkExit(250 - i));
  const paged = node({ list: many });
  const big = await L.fetchLive(paged.fetchFn, 't.loud-ab12.testnet', ['https://up.example']);
  assert.deepEqual(paged.calls.filter((p) => p.method_name === 'get_exits').map((p) => JSON.parse(atob(p.args_base64)).from_index), [0, 100, 200]);
  assert.equal(big.exits.length, 250);
  assert.deepEqual([big.exits[0].id, big.exits[249].id], [1n, 250n]);
  const bigView = L.boardView(big.exits, big.state.now, { clock: L.fmtUtcTime, limit: 12 });
  assert.equal(L.boardScope(bigView, { openOnly: true }), 'Showing 12 of 250 open exits.');
  assert.equal(bigView.expandable, true);
  assert.equal(L.boardScope(L.boardView(big.exits, big.state.now, { limit: 12, showAll: true }), { openOnly: true }), 'Showing all 250 open exits.');
  // get_state says 1 open exit in this fixture, so the mismatch is stated.
  assert.match(L.liveSummary(big, 't.loud-ab12.testnet'), /get_exits returned 250 exits while get_state reports 1 open\./);

  // The upper bound is disclosed when it is hit.
  const flood = node({ list: Array.from({ length: L.EXITS_PAGE * L.EXITS_MAX_PAGES + 5 }, (_, i) => mkExit(i + 1)) });
  const capped = await L.fetchLive(flood.fetchFn, 't.loud-ab12.testnet', ['https://up.example']);
  assert.equal(capped.exitsCapped, true);
  assert.equal(capped.exits.length, L.EXITS_PAGE * L.EXITS_MAX_PAGES);
  assert.match(L.liveSummary(capped, 't.loud-ab12.testnet'), /The page stops reading after 2000 exits; get_state reports 1 open exits\./);

  // An endpoint that cannot serve the pinned block: unpinned reads, and the text says so.
  const loose = await L.fetchLive(node({ canPin: false }).fetchFn, 't.loud-ab12.testnet', ['https://up.example']);
  assert.equal(loose.block.pinned, false);
  assert.deepEqual(loose.block.heights, [500, 501, 502]);
  assert.match(L.liveSummary(loose, 't.loud-ab12.testnet'), /read separately at final blocks 500 to 502, so they may not describe the same instant\./);
  assert.ok(!/at block 500/.test(L.liveSummary(loose, 't.loud-ab12.testnet')));
  const unpinned = await L.fetchLive(node({ height: false }).fetchFn, 't.loud-ab12.testnet', ['https://up.example']);
  assert.equal(unpinned.block.pinned, false);
  assert.match(L.liveSummary(unpinned, 't.loud-ab12.testnet'), /may come from adjacent blocks\./);
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

// Proof view model

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
  assert.equal(byLabel['Automated run that produced this'].href, 'https://github.com/someone/loud/actions/runs/123456');
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
  assert.equal(r.split.sentence, 'A group of 20 wallets sold 5,600,000 LOUD in 10 min 30 s. The cap allowed at most 5,750,000 LOUD in that time.');
});

test('proof: files written by the older and the newer proof script both render', () => {
  // The two files in the repository, as they are (older script, or the pending placeholders).
  const read = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
  const onDiskDep = L.deploymentView(read('./deployment.json'));
  const onDiskRec = L.receiptsView(read('./receipts.json'));
  assert.ok(['pending', 'ok', 'failed'].includes(onDiskDep.state));
  assert.ok(['pending', 'ok', 'failed'].includes(onDiskRec.state));

  // Older shape: none of the newer keys, so none of the newer rows.
  const { deployment, receipts } = fixture();
  const oldRows = L.receiptsView(receipts).split.rows.map((x) => x[0]);
  assert.ok(!oldRows.some((x) => /full cap window|failed receipt|did not pass/.test(x)));
  assert.ok(!L.deploymentView(deployment).rows.some((x) => /built wasm|intended ones/.test(x.label)));

  // Newer shape: additive keys on transactions, steps, split and deployment.
  const steps = receipts.steps.map((s) => {
    if (s.n === 1) return { ...s, txs: [{ hash: H('F'), account: null, outcome: 'unknown' }] };
    if (s.n === 9) {
      return {
        ...s, payout_calls: 100, payouts_settled: 99,
        txs: s.txs.map((t, i) => (t.outcome !== 'success' ? { ...t, settled: null }
          : i === 0 ? { ...t, settled: false, receipt_failures: 1, receipt_error: 'x' } : { ...t, settled: true })),
      };
    }
    return s;
  });
  const split = {
    ...receipts.split, pass: false, payout_calls: 100, payouts_settled: 99, measured_ns: '630000000000',
    full_window: true, timestamps_valid: true, fail_reasons: ['1 payout receipt failed'],
  };
  const r = L.receiptsView({ ...receipts, status: 'failed', steps, split });
  assert.equal(r.steps[0].txs[0].account, '');
  assert.equal(r.steps[0].txs[0].outcome, 'unknown');
  const nine = r.steps[8];
  assert.equal(nine.txs[0].unsettled, true);
  assert.equal(nine.txs[0].note, 'filled 40,000, a payout receipt failed');
  assert.equal(nine.txs[1].unsettled, false);
  assert.match(nine.txSummary, /100 succeeded, 200 failed on chain as recorded, 1 of the succeeded with a failed payout receipt$/);
  const rows = Object.fromEntries(r.split.rows);
  assert.equal(rows['Measured for at least one full cap window'], 'yes');
  assert.equal(rows['Paying calls with no failed receipt / paying calls'], '99 / 100');
  assert.equal(rows['Why the check did not pass'], '1 payout receipt failed');
  assert.equal(r.split.result, 'FAIL');
  // A passing newer run lists no reason, whether the key holds an empty list or null.
  for (const fr of [[], null]) {
    const ok = L.receiptsView({ ...receipts, split: { ...split, pass: true, payouts_settled: 100, fail_reasons: fr } });
    assert.equal(ok.split.result, 'PASS');
    assert.ok(!ok.split.rows.some((x) => x[0] === 'Why the check did not pass'));
  }
  const d = L.deploymentView({ ...deployment, expected_code_hash: 'abc', code_hash_match: true, params_match: false, param_mismatches: ['cap_bps'] });
  const dl = Object.fromEntries(d.rows.map((x) => [x.label, x.value]));
  assert.equal(dl['Code hash equals the hash of the built wasm'], 'yes');
  assert.equal(dl['On-chain parameters equal the intended ones'], 'no');
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

test('proof: the three large lines follow the files and never overstate them', () => {
  const { deployment, receipts } = fixture();
  const heads = (dep, rec) => L.proofHeadlines(L.deploymentView(dep), L.receiptsView(rec));
  const big = (list) => list.map((x) => `${x.state}: ${x.big}`);

  // A clean run.
  const ok = heads(deployment, receipts);
  assert.deepEqual(ok.map((x) => x.key), ['checks', 'keys', 'dump']);
  assert.deepEqual(big(ok), [
    'ok: 10 of 10 checks passed',
    'ok: 0 access keys',
    'ok: 20 wallets tried to dump. The cap held.',
  ]);
  assert.match(ok[0].small, /^on NEAR testnet(, \d{4}-\d{2}-\d{2})?\.$/);
  assert.equal(ok[0].href, `https://testnet.nearblocks.io/txns/${H('A')}`);
  assert.equal(ok[1].href, 'https://testnet.nearblocks.io/address/t.loud-ab12.testnet');
  assert.equal(ok[2].small, 'A group of 20 wallets sold 5,600,000 LOUD in 10 min 30 s. The cap allowed at most 5,750,000 LOUD in that time.');
  assert.equal(ok[2].href, 'receipts.json');

  // The numbers come from the files: a run with another number of checks and wallets.
  const eleven = heads(deployment, {
    ...receipts,
    steps: [...receipts.steps, { ...receipts.steps[9], n: 11 }],
    split: { ...receipts.split, wallets: 50 },
  });
  assert.equal(eleven[0].big, '11 of 11 checks passed');
  assert.equal(eleven[2].big, '50 wallets tried to dump. The cap held.');

  // A failed check, a key on the account and a broken cap are all shown as failed.
  const steps = receipts.steps.map((s) => (s.n === 10 ? { ...s, ok: false } : s));
  const bad = heads(
    { ...deployment, zero_keys: false, access_keys: ['ed25519:abc', 'ed25519:def'] },
    { ...receipts, status: 'failed', steps, split: { ...receipts.split, pass: false }, error: 'step 10 failed' },
  );
  assert.deepEqual(big(bad), [
    'failed: 9 of 10 checks passed',
    'failed: 2 access keys',
    'failed: 20 wallets tried to dump. The cap check failed.',
  ]);
  assert.match(bad[0].small, /step 10 failed/);
  assert.match(bad[1].small, /zero-key claim does not hold/);
  // All recorded checks passed but the file says the run failed: not shown as a pass.
  assert.equal(heads(deployment, { ...receipts, status: 'failed' })[0].state, 'failed');
  // The zero-key flag without a key list is not a pass either.
  assert.equal(heads({ ...deployment, access_keys: null }, receipts)[1].state, 'pending');
  assert.equal(heads({ ...deployment, zero_keys: false }, receipts)[1].state, 'failed');

  // Transactions with no confirmed outcome are named next to the pass.
  const unresolved = heads(deployment, { ...receipts, unresolved_txs: 3 });
  assert.equal(unresolved[0].state, 'ok');
  assert.match(unresolved[0].small, / 3 transactions were sent with no confirmed outcome\.$/);

  // Missing files: nothing is claimed.
  assert.deepEqual(big(heads(null, null)), [
    'pending: No run recorded yet',
    'pending: Access keys not checked yet',
    'pending: No dump measured yet',
  ]);
  assert.ok(heads(null, null).every((x) => !x.href));
});

test('proof: an unresolved transaction is never called "not executed" and qualifies the headline', () => {
  const { receipts } = fixture();
  const withUnknown = (n) => receipts.steps.map((s) => {
    if (s.n !== 9) return s;
    let left = n;
    return {
      ...s,
      txs: s.txs.map((t) => (t.outcome === 'failure' && left-- > 0
        ? { ...t, outcome: 'unknown', error_code: null, error: 'transaction was not final after 120s' } : t)),
    };
  });

  // None unresolved: the headline is the plain one and no count is added.
  const none = L.receiptsView(receipts);
  assert.equal(none.unresolved, 0);
  assert.equal(none.headline, 'All 10 steps passed on NEAR testnet.');
  assert.ok(!/unresolved/.test(none.steps[8].txSummary));

  // Four unresolved.
  const four = L.receiptsView({ ...receipts, steps: withUnknown(4) });
  assert.equal(four.unresolved, 4);
  assert.equal(four.headline, "All 10 steps passed on NEAR testnet. 4 transactions were sent but their outcome was not confirmed; the cap check rests on the contract's own counter.");
  const nine = four.steps[8];
  assert.equal(nine.unresolved, 4);
  assert.match(nine.txSummary, /^300 transactions: 100 succeeded, 196 failed on chain as recorded, 4 unresolved \(sent, outcome not confirmed\)$/);
  const unknown = nine.txs.filter((t) => t.outcome === 'unknown');
  assert.equal(unknown.length, 4);
  assert.ok(unknown.every((t) => t.label === L.UNRESOLVED_LABEL));
  assert.ok(nine.txs.filter((t) => t.outcome !== 'unknown').every((t) => t.label === t.outcome));
  assert.ok(!/not executed/.test(JSON.stringify({ h: four.headline, s: four.steps.map((s) => [s.txSummary, s.txs.map((t) => t.label)]) })));

  // One unresolved: singular wording. A missing or unrecognised outcome counts as unresolved too.
  const one = L.receiptsView({ ...receipts, steps: withUnknown(1) });
  assert.match(one.headline, / 1 transaction was sent but its outcome was not confirmed; the cap check rests on the contract's own counter\.$/);
  const odd = L.receiptsView({ ...receipts, steps: receipts.steps.map((s) => (s.n === 4 ? { ...s, txs: [{ hash: H('G'), account: 'a.testnet' }] } : s)) });
  assert.equal(odd.unresolved, 1);

  // "invalid" is a confirmed rejection before execution, not an unresolved call.
  const inv = L.receiptsView({ ...receipts, steps: receipts.steps.map((s) => (s.n === 4 ? { ...s, txs: [{ hash: H('G'), account: 'a.testnet', outcome: 'invalid' }] } : s)) });
  assert.equal(inv.unresolved, 0);
  assert.match(inv.steps[3].txSummary, /1 rejected before execution$/);

  // A null count (the script could not count) falls back to the records.
  const nullCount = L.receiptsView({ ...receipts, unresolved_txs: null, unresolved_note: null, steps: withUnknown(2) });
  assert.equal(nullCount.unresolved, 2);

  // A failed run keeps its own headline.
  const failed = L.receiptsView({ ...receipts, status: 'failed', steps: withUnknown(4) });
  assert.ok(!/outcome was not confirmed/.test(failed.headline));
  assert.equal(failed.unresolved, 4);

  // The file in the repository: the headline agrees with its own records.
  const disk = JSON.parse(read('./receipts.json'));
  // A file with the script's own count uses that; an older file is counted from its records
  // (sent, so with a hash; step 1 holds only the faucet's transaction in the saved run).
  const counted = (Array.isArray(disk.steps) ? disk.steps : []).reduce((a, s) => a + (Array.isArray(s.txs) ? s.txs : [])
    .filter((t) => Number(s.n) !== 1 && t && t.hash && !['success', 'failure', 'invalid'].includes(t.outcome)).length, 0);
  const n = Number.isInteger(disk.unresolved_txs) ? disk.unresolved_txs : counted;
  const onDisk = L.receiptsView(disk);
  assert.equal(onDisk.unresolved, n);
  if (onDisk.state === 'ok') assert.equal(/outcome was not confirmed|no confirmed outcome/.test(onDisk.headline), n > 0);
  // The transaction list prints `label`: every record has one, and none says "unknown" or "not executed".
  const labels = onDisk.steps.flatMap((s) => s.txs.map((x) => x.label));
  assert.ok(labels.every((x) => typeof x === 'string' && x.length > 0 && !/^unknown$|not executed/.test(x)));
  // A recorded step text that puts unconfirmed calls under "not executed" is never shown alone.
  for (const s of onDisk.steps) {
    const own = s.txs.filter((x) => x.unresolved).length;
    if (!Number.isInteger(disk.unresolved_txs) && own > 0 && /not executed/.test(s.got)) {
      assert.match(s.gotNote, new RegExp(`^Note: .*${own} of the calls in this step .* no confirmed outcome`));
    } else {
      assert.equal(s.gotNote, '');
    }
  }
});

test('proof: the keys of the newer proof script are shown, and an older file still renders', () => {
  const { receipts } = fixture();
  const w = 'w01.loud-ab12.testnet';
  const NOTE = '3 transactions that the run sent have no confirmed outcome: text written by the script.';
  const nine = [
    { hash: H('C'), account: w, outcome: 'success', error: null, round: 1, filled: String(40_000n * UNIT), settled: true },
    { hash: H('U'), account: w, outcome: 'unknown', error: 'transaction was not final after 120s', round: 1, filled: null },
    // A send that was signed three times: V has no lookup result, X was not found on chain.
    { hash: H('D'), account: w, outcome: 'failure', error: 'E_CAP: used up', error_code: 'E_CAP', round: 2,
      earlier_attempts: [H('V'), H('X')], earlier_attempt_outcomes: [{ hash: H('X'), outcome: 'invalid', error: null }] },
    // An earlier broadcast that did execute has a record of its own.
    { hash: H('Y'), account: w, outcome: 'success', error: null, round: 3, filled: String(1_000n * UNIT), settled: true, retried_as: H('Z') },
    { hash: H('Z'), account: w, outcome: 'failure', error: 'E_CAP: used up', error_code: 'E_CAP', round: 3,
      earlier_attempts: [H('Y')], earlier_attempt_outcomes: [{ hash: H('Y'), outcome: 'success', error: null }] },
    { hash: H('R'), account: w, outcome: 'failure', error: 'E_CAP: used up', error_code: 'E_CAP', round: 4, resolved_late: true },
    { hash: null, account: w, outcome: 'unknown', error: 'could not read the access key', round: 5 },
    { hash: H('I'), account: w, outcome: 'invalid', error: 'InvalidNonce', round: 5 },
  ];
  const newer = {
    ...receipts,
    unresolved_txs: 3,
    unresolved_hashes: [H('U'), H('V'), H('W')],
    unresolved_note: NOTE,
    split: { ...receipts.split, attempts: 8, fills: 2, cap_hits: 3, executed_failed: 3, not_executed: 2, unresolved: 1 },
    steps: receipts.steps.map((s) => {
      if (s.n === 9) return { ...s, got: '8 leave calls from 20 wallets: 2 filled; 3 executed and failed (3 E_CAP, 0 E_EXPIRED, 0 other); 2 not executed (refused before execution or never broadcast); 1 unresolved', txs: nine, executed_failed: 3, not_executed: 2, unresolved: 1 };
      if (s.n === 4) return { ...s, txs: [{ hash: H('E'), account: 'insider.loud-ab12.testnet', outcome: 'success', error: null, earlier_attempts: [H('W')], earlier_attempt_outcomes: [{ hash: H('W'), outcome: 'unknown', error: 'lookup failed' }] }] };
      // The faucet's own transaction, returned without a status: the script did not send it.
      if (s.n === 1) return { ...s, txs: [{ hash: H('F'), account: null, outcome: 'unknown', error: null }] };
      return s;
    }),
  };
  const v = L.receiptsView(newer);
  assert.equal(v.state, 'ok');
  // The script's count and its own paragraph are used.
  assert.equal(v.unresolved, 3);
  assert.equal(v.headline, `All 10 steps passed on NEAR testnet. ${NOTE}`);
  assert.deepEqual(v.unresolvedHashes, [H('U'), H('V'), H('W')]);
  // Here the records give the same number: 1 record and 1 earlier broadcast in step 9, 1 earlier broadcast in step 4, none in step 1.
  assert.deepEqual([v.steps[0].unresolved, v.steps[3].unresolved, v.steps[8].unresolved], [0, 1, 2]);
  // Every hash the script lists as unresolved is on the page, with a link.
  const shown = new Map(v.steps.flatMap((s) => s.txs.flatMap((t) => [[t.hash, t.href], ...t.earlier.map((e) => [e.hash, e.href])])));
  for (const hsh of v.unresolvedHashes) assert.equal(shown.get(hsh), `https://testnet.nearblocks.io/txns/${hsh}`);

  const s9 = v.steps[8];
  assert.equal(s9.gotNote, ''); // the newer step text keeps the groups apart itself
  assert.equal(s9.txSummary, '8 transactions: 2 succeeded, 3 failed on chain as recorded, 1 rejected before execution, 1 not sent, 1 unresolved (sent, outcome not confirmed); 3 earlier broadcasts replaced by a retry, 1 of them with no confirmed outcome');
  assert.equal(s9.txs[1].label, L.UNRESOLVED_LABEL);
  assert.deepEqual(s9.txs[2].earlier.map((e) => [e.hash, e.label]), [[H('V'), 'outcome not confirmed'], [H('X'), 'not found on chain']]);
  assert.match(s9.txs[3].note, /^filled 1,000, an earlier broadcast that did execute; the send was retried as /);
  assert.deepEqual(s9.txs[4].earlier.map((e) => e.label), ['succeeded']);
  assert.equal(s9.txs[5].note, 'E_CAP, outcome confirmed by a later lookup by hash');
  assert.equal(s9.txs[6].label, 'not sent (no transaction hash on record)');
  assert.equal(s9.txs[6].unresolved, false);
  assert.equal(s9.txs[7].label, 'invalid (rejected before execution)');
  assert.equal(v.steps[0].txs[0].label, 'outcome not reported by the faucet');
  assert.equal(v.steps[3].txSummary, '1 transaction: 1 succeeded, 0 failed on chain as recorded; 1 earlier broadcast replaced by a retry, 1 of them with no confirmed outcome');
  const rows = Object.fromEntries(v.split.rows);
  assert.equal(rows['Leave calls executed and failed / not executed / unresolved (sent, outcome not confirmed)'], '3 / 2 / 1');

  // The script's count wins over the records, also when it is 0 (only the faucet's record is unknown).
  const zero = L.receiptsView({ ...receipts, unresolved_txs: 0, unresolved_hashes: [], unresolved_note: null,
    steps: receipts.steps.map((s) => (s.n === 1 ? { ...s, txs: [{ hash: H('F'), account: 'testnet', outcome: 'unknown', error: null }] } : s)) });
  assert.equal(zero.unresolved, 0);
  assert.equal(zero.headline, 'All 10 steps passed on NEAR testnet.');
  // A count without a note falls back to the page's own sentence.
  const noNote = L.receiptsView({ ...newer, unresolved_note: null });
  assert.match(noNote.headline, / 3 transactions were sent but their outcome was not confirmed; the cap check rests on the contract's own counter\.$/);

  // An older file: none of the keys, no added row, no earlier broadcasts, and the old step text gets the page's note.
  const older = L.receiptsView({ ...receipts, steps: receipts.steps.map((s) => (s.n === 9
    ? { ...s, got: '300 leave calls from 20 wallets: 100 filled, 199 E_CAP, 0 E_EXPIRED, 0 other failures, 1 not executed', txs: s.txs.map((t, i) => (i === 1 ? { ...t, outcome: 'unknown', error_code: null } : t)) } : s)) });
  assert.equal(older.unresolved, 1);
  assert.deepEqual(older.unresolvedHashes, []);
  assert.ok(older.steps.every((s) => s.txs.every((t) => t.earlier.length === 0)));
  assert.ok(!older.split.rows.some(([label]) => /executed and failed/.test(label)));
  assert.match(older.steps[8].gotNote, /^Note: .* 1 of the calls in this step was sent and has no confirmed outcome; it is not known whether it never executed or executed and failed\.$/);
  assert.equal(older.steps[8].got, '300 leave calls from 20 wallets: 100 filled, 199 E_CAP, 0 E_EXPIRED, 0 other failures, 1 not executed');
});

test('snapshot: unpinned pages above 100 exits carry the paging caveat', () => {
  const s = { now: 1_800_000_000_000_000_000n, open_exits: 150 };
  const exits = Array.from({ length: 150 }, (_, i) => ({ id: BigInt(i + 1) }));
  const caveat = /pages in storage order, and these pages were not read at one block/;
  assert.match(L.liveSummary({ state: s, exits, exitsCapped: false, block: { pinned: false, height: 500, heights: [500, 501] } }, 't.testnet'), caveat);
  assert.ok(!caveat.test(L.liveSummary({ state: s, exits, exitsCapped: false, block: { pinned: true, height: 500, heights: [500] } }, 't.testnet')));
  assert.ok(!caveat.test(L.liveSummary({ state: { ...s, open_exits: 100 }, exits: exits.slice(0, 100), exitsCapped: false, block: { pinned: false, height: 500, heights: [500, 501] } }, 't.testnet')));
});

test('index.html: the static text makes no claim the contract does not back', () => {
  const html = read('./index.html');
  assert.match(html, /Waiting out the launch window avoids the tag/);
  assert.match(html, /The creator allocation is unbacked/);
  assert.match(html, /A notice can start a rush/);
  assert.match(html, /<dt>Sybil resistance<\/dt>/);
  // An exit is announced on chain. The board on the page is labelled as a simulation.
  assert.match(html, /the exit is announced on chain/);
  assert.match(html, /id="hero-note">Simulation: /);
  // A shout cannot be cancelled, it does not force a sale, and storage is paid per account.
  assert.match(html, /<b>A shout cannot be cancelled\.<\/b> The tokens stay locked until they are sold/);
  assert.match(html, /<dt>A shout is not a sale<\/dt>/);
  assert.match(html, /Storage costs 0\.03 NEAR per account/);
  // One word per thing in the reader's text: cap and exit.
  const visible = html.replace(/<[^>]+>/g, ' ');
  assert.ok(!/\bbucket\b|\bthe door\b|\bescrow/i.test(visible));
});

test('index.html: the proof lines readable without the page script are the recorded run', () => {
  const html = read('./index.html');
  const json = (name) => JSON.parse(read(name));
  const dep = json('./deployment.json');
  const d = L.deploymentView(dep);
  const r = L.receiptsView(json('./receipts.json'));
  const esc = L.escapeHtml;
  // A line without a target has no link, as on the page.
  const anchor = (href, label) => (href ? `<a href="${esc(href)}" rel="noopener">${esc(label)}</a>` : '');
  const slice = (id, end) => html.slice(html.indexOf(`id="${id}"`), html.indexOf(end, html.indexOf(`id="${id}"`)));
  // The three large lines, exactly as the page script renders them.
  const facts = slice('proof-facts', '</ul>');
  const heads = L.proofHeadlines(d, r);
  for (const x of heads) {
    assert.ok(facts.includes(`<li data-state="${x.state}"><b>${esc(x.big)}</b><span>${esc(x.small)}</span>${anchor(x.href, x.linkText)}</li>`), `static proof line: ${x.key}`);
  }
  // The summary rows name the token and the result.
  assert.ok(slice('sum-token', '</dd>').includes(d.token ? anchor(d.tokenHref, d.token) : '>Not deployed yet.'));
  assert.ok(slice('sum-proof', '</dd>').includes(`${esc(heads[0].big)}. ${esc(heads[2].big)} `));
  // What the run does not check is said in the static text whenever the view model says it.
  assert.equal(slice('sum-proof', '</dd>').includes('Recorded before two later rules, listed under Testnet proof.'), Boolean(r.scopeNote));
  assert.equal(slice('proof-scope', '</p>'), `id="proof-scope"${r.scopeNote ? '' : ' hidden'}>${esc(r.scopeNote)}`);
  // The sentence under "The checks" is shown when it adds something to the large line.
  const quiet = r.state === 'ok' && r.unresolved === 0 && !r.error;
  assert.equal(slice('rec-state', '</p>'), quiet
    ? 'id="rec-state" data-state="pending" hidden>'
    : `id="rec-state" data-state="${r.state}">${esc(r.error ? `${r.headline} The run stopped early: ${r.error}` : r.headline)}`);
  assert.ok(html.includes(`<p class="state" id="dep-state" data-state="${d.state}">${esc(d.headline)}</p>`));
  // The dump line carries its own state; without a measurement it has no result word.
  const spState = r.split.result === 'PASS' ? 'ok' : r.split.result === 'FAIL' ? 'failed' : 'pending';
  assert.ok(html.includes(`id="split-proof-state" data-state="${spState}">${esc(r.split.have ? `${r.split.result}. ${r.split.sentence}` : r.split.sentence)}</p>`));
  const stamp = r.generatedAt || d.generatedAt;
  assert.ok(html.includes(`<span id="proof-stamp">${stamp ? `Recorded ${esc(stamp)}.` : 'Not recorded yet.'}</span>`));
  // Every recorded check has a static row with its number and result, three of them shown first.
  const { key, rest } = L.splitChecks(r.steps);
  if (r.steps.length === 10) assert.deepEqual(key.map((s) => s.n), [...L.KEY_CHECKS]);
  const rowsOf = (id) => [...slice(id, '</table>').matchAll(/<tr><td>(\d+)\. [^<]+<span class="expect">Expected: [^<]+<\/span><\/td><td class="res" data-result="(\w+)">\2<\/td><\/tr>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(rowsOf('steps-key'), key.map((s) => [s.n, s.result]));
  assert.deepEqual(rowsOf('steps-table'), rest.map((s) => [s.n, s.result]));
  // No other row is left over, and the folded list is hidden when it is empty.
  assert.equal((slice('steps-key', '</table>') + slice('steps-table', '</table>')).split('<tr><td>').length - 1, r.steps.length);
  assert.equal(slice('steps-rest', '>'), `id="steps-rest"${rest.length ? '' : ' hidden'}`);
  // The README names the same token account and the same day.
  const readme = read('../README.md');
  const day = /^\d{4}-\d{2}-\d{2}T/.test(stamp) ? stamp.slice(0, 10) : '';
  if (d.token) {
    assert.ok(readme.includes(`[${d.token}](${d.tokenHref})`));
    if (day) assert.ok(readme.includes(`, recorded ${day}`));
    // "No access keys" and a clean result are said only when the files say so.
    assert.equal(/\), no access keys/.test(readme), d.zeroKeys);
    assert.equal(readme.includes(', the last run did not pass<!--'), !(d.state === 'ok' && r.state === 'ok'));
  } else {
    assert.ok(readme.includes('Testnet token: <!-- proof:token -->none recorded by the last run<!--'));
  }
  // The README names the commit the token was built from, and says so when rules came after it.
  const commit = dep.run && typeof dep.run.commit === 'string' && /^[0-9a-f]{7,40}$/.test(dep.run.commit) ? dep.run.commit.slice(0, 7) : '';
  assert.equal(readme.includes('built from commit'), Boolean(commit));
  if (commit) assert.ok(readme.includes(`built from commit \`${commit}\``));
  assert.equal(readme.includes('Two rules came after that commit'), Boolean(r.scopeNote));
});

test('proof: three checks are shown first and the others folded', () => {
  const steps = Array.from({ length: 10 }, (_, i) => ({ n: String(i + 1) }));
  const { key, rest } = L.splitChecks(steps);
  assert.deepEqual(key.map((s) => s.n), ['6', '8', '10']);
  assert.deepEqual(rest.map((s) => s.n), ['1', '2', '3', '4', '5', '7', '9']);
  // A file with other step numbers shows everything.
  assert.deepEqual(L.splitChecks([{ n: '1' }, { n: '2' }]), { key: [{ n: '1' }, { n: '2' }], rest: [] });
});

test('index.html: structure a parser can rely on', () => {
  const html = read('./index.html');
  assert.match(html, /<meta name="description" content="[^"]{80,300}">/);
  // Section ids, in page order.
  const ids = [...html.matchAll(/<section[^>]* id="([\w-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['board', 'rule', 'split', 'sandbox', 'proof', 'limits', 'parameters']);
  // One h2 per section with an id, and no heading level is skipped.
  for (const id of ids) {
    const at = html.indexOf(`id="${id}"`);
    const body = html.slice(at, html.indexOf('</section>', at));
    assert.equal((body.match(/<h2[ >]/g) || []).length, 1, `${id} needs exactly one h2`);
    assert.ok(!/<h[456][ >]/.test(body));
  }
  // The summary is a definition list near the top, before the rule section.
  const sum = html.indexOf('<section class="summary" aria-label="Summary">');
  assert.ok(sum > html.indexOf('id="board"') && sum < html.indexOf('id="rule"'));
  const dl = html.slice(sum, html.indexOf('</section>', sum));
  const terms = [...dl.matchAll(/<dt>([^<]+)<\/dt>/g)].map((m) => m[1]);
  assert.deepEqual(terms, ['What it is', 'Network', 'Token account', 'Proof', 'Claim', 'Source']);
  // Links say where they go.
  for (const m of html.matchAll(/<a [^>]*>([^<]*)<\/a>/g)) {
    assert.ok(m[1].trim().length >= 4 && !/^(here|click here|link|more)$/i.test(m[1].trim()), `vague link text: ${m[0]}`);
  }
  // No text is hidden from readers by style.
  assert.ok(!/display:\s*none|visibility:\s*hidden|font-size:\s*0/.test(html));
});

test('index.html: the static result lines are what the engine computes for the default choice', () => {
  const html = read('./index.html');
  // The form defaults: 5% of supply, 100 wallets.
  assert.match(html, /name="share" value="500" checked/);
  assert.match(html, /name="wallets" value="100" checked/);
  const heads = L.resultHeadlines(L.runComparison({ wallets: 100, shareBps: 500 }).stats);
  for (const x of heads) {
    assert.ok(html.includes(`<li data-rule="${x.rule}"><span class="v-rule">${x.name}</span><b class="v-line">${x.line}</b><span class="v-sub">${x.sub}</span></li>`), `static line for ${x.rule}`);
  }
  // The static table rows are the same run.
  const rules = ['naive', 'per_wallet', 'loud'];
  L.resultTable(L.runComparison({ wallets: 100, shareBps: 500 }).stats).forEach((row, i) => {
    const sub = (text) => (row.note ? `<span class="sub">${text}</span>` : '');
    assert.ok(html.includes(`<tr data-rule="${rules[i]}"><td>${row.label}</td><td>${row.single}</td><td>${row.split}${sub(row.note)}</td><td>${row.drop1}</td><td>${row.dropMax}${sub('sale still running')}</td></tr>`), `static table row for ${rules[i]}`);
  });
  assert.match(html, /<th scope="col">Same, 100 wallets<\/th>/);
  assert.match(html, /<th scope="col">Price fall after 1 min, 100 wallets<\/th>/);
  assert.match(html, /<th scope="col">Largest price fall in 6 h, 100 wallets<\/th>/);
});

test('result lines: every choice of share and wallets', () => {
  const cache = new Map();
  for (const shareBps of L.SHARE_CHOICES_BPS) {
    for (const wallets of L.WALLET_CHOICES) {
      const { stats } = L.runComparison({ wallets, shareBps }, cache);
      const [naive, pw, loud] = L.resultHeadlines(stats);
      assert.deepEqual([naive.rule, pw.rule, loud.rule], ['naive', 'per_wallet', 'loud']);
      const who = wallets === 1 ? '1 wallet' : `${wallets} wallets`;
      for (const x of [naive, pw, loud]) assert.ok(x.line.startsWith(`${who}: `), x.line);
      assert.equal(naive.line, `${who}: sold in 1 min`);
      if (wallets === 1) {
        assert.equal(pw.line, `1 wallet: sold in ${L.fmtDuration(stats.per_wallet.sellOutSecSingle)}`);
        assert.match(loud.line, /^1 wallet: \d+\.\d% out after 6 h$/);
      } else {
        // The split never changes what LOUD lets out; under per-wallet limits it does.
        assert.equal(loud.line, `${who}: same as 1 wallet`);
        assert.ok(stats.loud.maxDiffUnits <= BigInt(wallets));
        assert.match(pw.sub, /^1 wallet took \d+ min\. Splitting made it \d+x faster\.$/);
        assert.match(loud.sub, /^\d+\.\d% out after 6 h\. Nothing sold before minute 31\.$/);
      }
    }
  }
  // A split run that differs from the single-wallet run by more than rounding is not called the same.
  const { stats } = L.runComparison({ wallets: 10, shareBps: 500 }, cache);
  const odd = L.resultHeadlines({ ...stats, loud: { ...stats.loud, maxDiffUnits: 11n, soldAtEndSingle: 0.5 } })[2];
  assert.equal(odd.line, '10 wallets: 61.7% out after 6 h, 1 wallet: 50.0%');
  // A position that is never sold says so.
  const stuck = L.resultHeadlines({ ...stats, naive: { ...stats.naive, sellOutSec: null }, per_wallet: { ...stats.per_wallet, sellOutSec: null, speedup: null } });
  assert.equal(stuck[0].line, '10 wallets: not sold out in 6 h');
  assert.equal(stuck[1].line, '10 wallets: not sold out in 6 h');
  assert.equal(stuck[1].sub, '1 wallet took 10 min.');
});

test('proof: a run recorded before storage and binding shouts says what it does not check', () => {
  const { receipts } = fixture();
  const older = L.receiptsView(receipts);
  assert.match(older.scopeNote, /recorded before two later rules: each account pays for its storage, and a shout cannot be cancelled/);
  assert.deepEqual(older.tokenNear, []);
  assert.equal(older.steps[4].txs[0].call, '');
  // The saved file is shown with whatever its own keys support.
  const saved = L.receiptsView(JSON.parse(read('./receipts.json')));
  assert.equal(saved.scopeNote === '', saved.state === 'pending' || Object.hasOwn(JSON.parse(read('./receipts.json')), 'token_near'));

  const N = 10n ** 24n;
  const reading = (balance) => ({
    balance: String(balance), pool_near: String(2n * N), owed_total: '0', spare: String(balance - 2n * N),
    storage_bytes: 230000, storage_stake: String(23n * N / 10n), free: String(balance - 2n * N - 23n * N / 10n),
  });
  const newer = L.receiptsView({
    ...receipts,
    token_near: { at_deploy: null, at_end: reading(5n * N) },
    steps: receipts.steps.map((s) => {
      if (s.n === 5) return { ...s, registration: { wallets: 20, registered: 20 }, txs: [{ hash: H('E'), account: 'w01.loud-ab12.testnet', outcome: 'success', error: null, call: 'storage_deposit' }] };
      return s;
    }),
  });
  assert.equal(newer.scopeNote, '');
  assert.equal(newer.steps[4].txs[0].call, 'storage_deposit');
  assert.deepEqual(newer.tokenNear, [
    ['Balance of the token account at the end of the run', '5.0000 NEAR'],
    ['Of that, pool liquidity (pool_near)', '2.0000 NEAR'],
    ['Owed for failed payouts', '0.0000 NEAR'],
    ['Locked by the protocol for storage', '2.3000 NEAR (230,000 bytes of code and records)'],
    ['Left after all three', '0.7000 NEAR'],
  ]);
  // A balance that does not cover all three shows as a negative remainder.
  const short = L.receiptsView({ ...receipts, token_near: { at_deploy: reading(4n * N), at_end: null } });
  assert.equal(short.tokenNear[4][1], '-0.3000 NEAR');
  assert.equal(short.tokenNear[0][0], 'Balance of the token account right after the deploy');
  // A run of the current script that stopped early has the key with nothing read:
  // it is a failed run of the current contract, not an older one.
  const stopped = L.receiptsView({ ...receipts, status: 'failed', steps: receipts.steps.slice(8), token_near: { at_deploy: null, at_end: null } });
  assert.equal(stopped.scopeNote, '');
  assert.deepEqual(stopped.tokenNear, []);
  assert.equal(L.receiptsView({ status: 'pending' }).scopeNote, '');
});

test('real launch: the lines on the page carry the numbers of the case file and sim/REPLAY.md', () => {
  const html = read('./index.html');
  const data = JSON.parse(read('../sim/replay-data/case-1.json'));
  const replay = read('../sim/REPLAY.md');
  // The part of REPLAY.md about this launch.
  const from = replay.indexOf(`## ${data.label}`);
  assert.ok(from > 0);
  const part = replay.slice(from, replay.indexOf('\n## ', from + 1));
  const row = (label) => {
    const line = part.split('\n').find((l) => l.startsWith(`| ${label} |`));
    assert.ok(line, `REPLAY.md has no row "${label}"`);
    return line.split('|').slice(2, -1).map((c) => c.trim());
  };
  // Cells are "share of the bundle (share of supply)"; columns are on chain, no rule, per-wallet, LOUD.
  const ofBundle = (cell) => cell.split(' ')[0];
  const onChain10 = ofBundle(row('10 min')[0]);
  const loud60 = ofBundle(row('60 min')[3]);
  const loudDone = row('all sold after')[3];
  const notice = part.match(/Holders see the exit (\d+) minutes before the first unit sells/)[1];
  // Measured figures, from the case file.
  const wallets = data.bundle.wallets.length;
  const bought = Math.round(data.bundle.share_bps_measured / 100);
  const soldIn = Math.ceil(data.bundle.last_sell_s / 60);
  assert.equal(data.bundle.last_buy_s, 0);
  assert.equal(onChain10, `${data.cumulative['10m'].pct_of_bundle.toFixed(2)}%`);

  const at = html.indexOf('<h3 class="real-head" id="real-h">It happened like this on pump.fun</h3>');
  assert.ok(at > html.indexOf('id="split"') && at < html.indexOf('id="sandbox"'));
  const block = html.slice(at, html.indexOf('</section>', at));
  assert.ok(block.includes(`<b class="v-line">${wallets} wallets bought ${bought}% of the supply</b>`));
  assert.ok(block.includes(`<span class="v-sub">In the block that created the token, on 15 June ${data.launch_iso.slice(0, 4)}.</span>`));
  assert.equal(data.launch_iso.slice(0, 10), '2026-06-15');
  assert.ok(block.includes(`<b class="v-line">They sold all of it in ${soldIn} minutes</b>`));
  assert.ok(block.includes(`<span class="v-sub">${onChain10} of it was gone after 10 minutes.</span>`));
  assert.ok(block.includes(`<li data-rule="loud"><span class="v-rule">Under LOUD</span><b class="v-line">${loud60} of it out after 60 minutes</b>`));
  assert.ok(block.includes(`<span class="v-sub">${notice} minutes of public notice first. Selling all of it would take ${loudDone}.</span>`));
  // The source, the mint, and the line that says which part is a model.
  assert.ok(block.includes(`href="${data.sources[0].url}"`));
  assert.ok(block.includes(`<code>${data.token.address}</code>`));
  assert.match(block, /The first two lines are measured on chain\. The LOUD line replays the same sales through the rule engine/);
  assert.equal(notice, String(Number(PRESETS.standard.notice_ns / MIN)));
});
