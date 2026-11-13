// Page wiring for LOUD. All rules live in engine.js; all DOM-free logic and
// formatting live in ui-logic.js. This file only reads inputs and writes DOM.
// Data from JSON files and RPC is written with textContent, never as HTML.

import * as L from './ui-logic.js';

const $ = (sel, root = document) => root.querySelector(sel);
const SVG_NS = 'http://www.w3.org/2000/svg';
const MIN_NS = 60n * 1_000_000_000n;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c !== null && c !== undefined) node.append(c);
  return node;
}

function s(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

// replaceChildren that skips null (the DOM method would print "null").
function put(node, ...children) {
  node.replaceChildren(...children.filter((c) => c !== null && c !== undefined));
}

function link(href, label) {
  return href ? h('a', { href, rel: 'noopener', target: '_blank', text: label }) : document.createTextNode(label);
}

function setText(node, value) {
  if (node && node.textContent !== value) node.textContent = value;
}

// ---------------------------------------------------------------- board

function setStatus(tr, span, status) {
  span.textContent = status;
  span.dataset.status = status;
  tr.dataset.status = status;
}

function flipStatus(tr, span, status) {
  if (reducedMotion.matches) return setStatus(tr, span, status);
  span.classList.remove('flip-in');
  span.classList.add('flip-out');
  setTimeout(() => {
    setStatus(tr, span, status);
    span.classList.remove('flip-out');
    span.classList.add('flip-in');
    setTimeout(() => span.classList.remove('flip-in'), 200);
  }, 150);
}

// Keeps one <tr> per exit id, so only cells that change are touched and only
// a changed status flips.
function createBoard(table, { actions = false } = {}) {
  const tbody = table.tBodies[0];
  const cols = table.tHead.rows[0].cells.length;
  let byId = new Map();
  let source = null;

  function makeRow(row) {
    const status = h('span', { class: 'status' });
    const detail = h('span', { class: 'detail' });
    const cells = {
      id: h('td', { class: 'c-id' }),
      account: h('td', { class: 'c-acct' }),
      amount: h('td', { class: 'c-amt' }),
      shouted: h('td', { class: 'c-shout' }),
      ready: h('td', { class: 'c-ready' }),
      statusCell: h('td', { class: 'c-status' }, status, detail),
    };
    const tr = h('tr', {}, ...Object.values(cells));
    const entry = { tr, cells, status, detail, shown: null, act: null, actKey: '' };
    if (actions) {
      entry.act = h('td', { class: 'c-act' });
      tr.append(entry.act);
    }
    setStatus(tr, status, row.status);
    entry.shown = row.status;
    return entry;
  }

  function update(rows, emptyText, key = 'default') {
    if (key !== source) {
      tbody.replaceChildren();
      byId = new Map();
      source = key;
    }
    const empty = $('.board-empty', tbody);
    if (rows.length === 0) {
      byId = new Map();
      tbody.replaceChildren(h('tr', { class: 'board-empty' }, h('td', { colspan: String(cols), text: emptyText })));
      return;
    }
    if (empty) empty.remove();
    const seen = new Set();
    rows.forEach((row, i) => {
      seen.add(row.id);
      let e = byId.get(row.id);
      if (!e) {
        e = makeRow(row);
        byId.set(row.id, e);
      } else if (e.shown !== row.status) {
        e.shown = row.status;
        flipStatus(e.tr, e.status, row.status);
      }
      setText(e.cells.id, row.id);
      setText(e.cells.account, row.account);
      e.cells.account.title = row.account;
      setText(e.cells.amount, row.amount);
      e.cells.amount.title = `${row.amountFull} LOUD`;
      setText(e.cells.shouted, row.shouted);
      setText(e.cells.ready, row.ready);
      setText(e.detail, row.detail);
      if (e.act) {
        const actKey = `${row.canLeave}/${row.canHush}`;
        if (actKey !== e.actKey) {
          e.actKey = actKey;
          put(e.act,
            row.canLeave ? h('button', { type: 'button', 'data-do': 'leave', 'data-id': row.id, text: 'Leave', 'aria-label': `Leave exit ${row.id}` }) : null,
            row.canHush ? h('button', { type: 'button', 'data-do': 'hush', 'data-id': row.id, text: 'Hush', 'aria-label': `Hush exit ${row.id}` }) : null,
          );
        }
      }
      if (tbody.children[i] !== e.tr) tbody.insertBefore(e.tr, tbody.children[i] || null);
    });
    for (const [id, e] of byId) {
      if (!seen.has(id)) {
        e.tr.remove();
        byId.delete(id);
      }
    }
  }

  return { update };
}

function setCap(bar, textNode, fraction, text) {
  const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  bar.setAttribute('aria-valuenow', String(pct));
  bar.setAttribute('aria-valuetext', text);
  bar.firstElementChild.style.width = `${pct}%`;
  setText(textNode, text);
}

// ---------------------------------------------------------------- hero board

const hero = {
  board: null,
  sim: null,
  source: 'sim',
  paused: false,
  timer: null,
  live: null,
  showAll: { sim: false, live: false },
  scope: null,
};

// The line under the board that says how many exits the rows cover, with a
// button to show all of them. Built once so a tick does not replace the button.
function heroScope(view, sentence) {
  const box = $('#hero-scope');
  if (!hero.scope) {
    const text = h('span');
    const btn = h('button', { type: 'button' });
    btn.addEventListener('click', () => {
      hero.showAll[hero.source] = !hero.showAll[hero.source];
      if (hero.source === 'sim') heroRenderSim();
      else heroRenderLive();
    });
    box.replaceChildren(text, ' ', btn);
    hero.scope = { text, btn };
  }
  box.hidden = !sentence;
  setText(hero.scope.text, sentence);
  hero.scope.btn.hidden = !view.expandable;
  setText(hero.scope.btn, hero.showAll[hero.source] ? 'Show fewer' : `Show all ${view.total}`);
}

function heroRenderSim() {
  const sim = hero.sim;
  const st = sim.state();
  const view = L.boardView(sim.exits(), sim.now, { limit: 9, showAll: hero.showAll.sim });
  hero.board.update(view.rows, 'No exits yet.', 'sim');
  heroScope(view, view.total ? `${L.boardScope(view)} Simulated exits, not chain data.` : '');
  setText($('#board-clock-label'), 'Engine clock');
  setText($('#board-clock'), L.fmtSinceLaunch(sim.now));
  setCap($('#hero-cap-bar'), $('#hero-cap-text'), Number((st.cap_available * 1000n) / st.cap_units) / 1000,
    `${L.fmtCompact(st.cap_available)} of ${L.fmtCompact(st.cap_units)} LOUD. Left so far: ${L.fmtCompact(st.total_left)}`);
}

function heroRenderLive() {
  const live = hero.live;
  if (!live) return;
  const st = live.state;
  const view = L.boardView(live.exits, st.now, { clock: L.fmtUtcTime, limit: 12, showAll: hero.showAll.live });
  hero.board.update(
    view.rows,
    'No open exits on chain in this snapshot. The contract stores open exits only. The receipts under Testnet proof cover the saved proof run only; exits completed outside that run are not listed on this page.',
    'live',
  );
  const whole = live.exitsCapped
    ? ` The page stopped reading after ${live.exits.length} exits; get_state reports ${st.open_exits} open.`
    : Number(st.open_exits) !== live.exits.length ? ` get_state reports ${st.open_exits} open.` : '';
  heroScope(view, view.total ? `${L.boardScope(view, { openOnly: true })}${whole} Completed exits are not stored by the contract.` : '');
  setText($('#board-clock-label'), 'Chain time, UTC');
  setText($('#board-clock'), L.fmtUtcTime(st.now));
  setCap($('#hero-cap-bar'), $('#hero-cap-text'), Number((st.cap_available * 1000n) / st.cap_units) / 1000,
    `${L.fmtCompact(st.cap_available)} of ${L.fmtCompact(st.cap_units)} LOUD. Left so far: ${L.fmtCompact(st.total_left)}`);
}

function heroTick() {
  if (hero.source !== 'sim') return;
  if (hero.sim.done) hero.sim = startSim();
  else hero.sim.step();
  heroRenderSim();
}

function startSim() {
  const sim = L.createBoardSim();
  // Start a few minutes before the first notice ends, so a status flips soon.
  for (let i = 0; i < 27; i++) sim.step();
  return sim;
}

function heroSchedule() {
  clearInterval(hero.timer);
  hero.timer = null;
  if (hero.source === 'sim' && !hero.paused && !document.hidden) hero.timer = setInterval(heroTick, 400);
}

const SIM_NOTE = 'Simulation on the rule engine, standard parameters: the 5% creator allocation, split across 36 wallets, leaves through the door with a simple seller strategy that shouts in batches. It is not the fastest exit the rule allows: it can wait between batches while the cap has room. One engine minute every 0.4 s.';

function heroSetSource(source) {
  hero.source = source;
  $('#src-sim').setAttribute('aria-pressed', String(source === 'sim'));
  $('#src-live').setAttribute('aria-pressed', String(source === 'live'));
  $('#hero-pause').hidden = source !== 'sim';
  $('#hero-step').hidden = source !== 'sim';
  if (source === 'sim') {
    setText($('#hero-note'), SIM_NOTE);
    heroRenderSim();
  } else {
    const b = hero.live ? hero.live.block : null;
    setText($('#hero-note'), `Snapshot of the deployed token, read with get_state and get_exits${b && b.pinned ? ` at block ${b.height}` : ''}. It does not update on its own; "read again" under Testnet proof takes a new one. Times are block times. Demo preset on testnet.`);
    heroRenderLive();
  }
  heroSchedule();
}

function initHero() {
  hero.board = createBoard($('#hero-table'));
  hero.sim = startSim();
  hero.paused = reducedMotion.matches;
  const pause = $('#hero-pause');
  const syncPause = () => {
    pause.setAttribute('aria-pressed', String(hero.paused));
    setText(pause, hero.paused ? 'Play' : 'Pause');
  };
  syncPause();
  pause.addEventListener('click', () => {
    hero.paused = !hero.paused;
    syncPause();
    heroSchedule();
  });
  $('#hero-step').addEventListener('click', () => {
    hero.paused = true;
    syncPause();
    heroSchedule();
    heroTick();
  });
  $('#src-sim').addEventListener('click', () => heroSetSource('sim'));
  $('#src-live').addEventListener('click', () => { if (hero.live) heroSetSource('live'); });
  document.addEventListener('visibilitychange', heroSchedule);
  heroSetSource('sim');
}

// ---------------------------------------------------------------- charts

function frame(container, height, margin) {
  const width = Math.max(240, Math.floor(container.clientWidth || 320));
  const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img' });
  return { svg, width, height, m: margin };
}

function xAxis(f, minutes, x) {
  const { svg, height, m } = f;
  const base = height - m.b;
  svg.append(s('line', { class: 'axis', x1: m.l, x2: f.width - m.r, y1: base, y2: base }));
  const ticks = minutes <= 60 ? [0, 15, 30, 45, 60] : [0, 60, 120, 180, 240, 300, 360];
  for (const t of ticks) {
    svg.append(s('line', { class: 'axis', x1: x(t), x2: x(t), y1: base, y2: base + 4 }));
    const label = minutes <= 60 ? String(t) : String(t / 60);
    svg.append(s('text', { x: x(t), y: base + 16, 'text-anchor': t === ticks.at(-1) ? 'end' : t === 0 ? 'start' : 'middle' }, label));
  }
  svg.append(s('text', { x: (m.l + f.width - m.r) / 2, y: base + 31, 'text-anchor': 'middle' },
    minutes <= 60 ? 'minutes after the insider starts' : 'hours after the insider starts'));
}

function drawSold(container, split, single, minutes, { label, markMinute, markText }) {
  const f = frame(container, 204, { l: 40, r: 8, t: 10, b: 38 });
  const { svg, m } = f;
  const x = L.linear(0, minutes, m.l, f.width - m.r);
  const y = L.linear(0, 1, f.height - m.b, m.t);
  for (const v of [0.5, 1]) {
    svg.append(s('line', { class: 'grid', x1: m.l, x2: f.width - m.r, y1: y(v), y2: y(v) }));
  }
  for (const v of [0, 0.5, 1]) {
    svg.append(s('text', { x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end' }, `${v * 100}%`));
  }
  xAxis(f, minutes, x);
  if (markMinute !== null && markMinute <= minutes) {
    svg.append(s('line', { class: 'mark', x1: x(markMinute), x2: x(markMinute), y1: m.t, y2: f.height - m.b }));
    svg.append(s('text', { x: x(markMinute) + 5, y: m.t + 10 }, markText));
  }
  const px = (pts) => L.pathFrom(pts.map(([a, b]) => [x(a), y(b)]));
  svg.append(s('path', { class: 'l-split', d: px(L.seriesPoints(split, 'insiderSold', minutes)) }));
  svg.append(s('path', { class: 'l-single', d: px(L.seriesPoints(single, 'insiderSold', minutes)) }));
  svg.setAttribute('aria-label', label);
  container.replaceChildren(svg);
}

function drawPrice(container, series, minutes) {
  const f = frame(container, 224, { l: 40, r: 96, t: 12, b: 38 });
  const { svg, m } = f;
  const rel = (ser) => L.seriesPoints(ser, 'price', minutes).map(([a, b]) => [a, b / ser[0].price]);
  const lines = [
    { key: 'naive', cls: 'l-naive', name: 'No rule', pts: rel(series.naive) },
    { key: 'per_wallet', cls: 'l-pw', name: 'Per-wallet', pts: rel(series.per_wallet) },
    { key: 'loud', cls: 'l-loud', name: 'LOUD', pts: rel(series.loud) },
  ];
  const x = L.linear(0, minutes, m.l, f.width - m.r);
  const y = L.linear(0, 1, f.height - m.b, m.t);
  for (const v of [0.25, 0.5, 0.75, 1]) {
    svg.append(s('line', { class: 'grid', x1: m.l, x2: f.width - m.r, y1: y(v), y2: y(v) }));
  }
  for (const v of [0, 0.5, 1]) {
    svg.append(s('text', { x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end' }, `${v * 100}%`));
  }
  xAxis(f, minutes, x);
  for (const ln of lines) {
    svg.append(s('path', { class: ln.cls, d: L.pathFrom(ln.pts.map(([a, b]) => [x(a), y(Math.min(b, 1.02))])) }));
  }
  // Direct labels at the right end, pushed apart when lines end close together.
  const ends = lines.map((ln) => ({ ...ln, end: ln.pts.at(-1)[1], ly: y(Math.min(ln.pts.at(-1)[1], 1.02)) + 4 }))
    .sort((a, b) => a.ly - b.ly);
  for (let i = 1; i < ends.length; i++) if (ends[i].ly - ends[i - 1].ly < 14) ends[i].ly = ends[i - 1].ly + 14;
  const over = ends.at(-1).ly - (f.height - m.b);
  if (over > 0) for (const e of ends) e.ly -= over;
  for (const e of ends) {
    svg.append(s('text', { class: e.key === 'loud' ? 'series-loud' : 'series', x: f.width - m.r + 6, y: e.ly }, `${e.name} ${Math.round(e.end * 100)}%`));
  }
  svg.setAttribute('aria-label', `Price after ${minutes} minutes as a share of the starting price: ${lines.map((ln) => `${ln.name} ${Math.round(ln.pts.at(-1)[1] * 100)}%`).join(', ')}.`);
  container.replaceChildren(svg);
}

// ---------------------------------------------------------------- split attack

const split = { cache: new Map(), result: null, minutes: 60 };

function drawSplit() {
  const r = split.result;
  if (!r) return;
  const n = r.stats.wallets;
  // The insider shouts in its first step, so the first leave lands one notice later.
  const firstLeaveMin = r.stats.loud.firstSaleSec === null ? null : r.stats.loud.firstSaleSec / 60;
  const names = { naive: 'No rule', per_wallet: 'Per-wallet limits', loud: 'LOUD' };
  for (const rule of ['naive', 'per_wallet', 'loud']) {
    const end = (ser) => L.fmtPct(L.seriesPoints(ser, 'insiderSold', split.minutes).at(-1)[1]);
    drawSold($(`#plot-${rule}`), r.series[rule], r.single[rule], split.minutes, {
      label: `${names[rule]}: share of the insider position sold after ${split.minutes} minutes. ${n} wallets ${end(r.series[rule])}, one wallet ${end(r.single[rule])}.`,
      markMinute: rule === 'loud' ? firstLeaveMin : null,
      markText: 'first leave',
    });
  }
  drawPrice($('#plot-price'), r.series, split.minutes);
}

function renderSplit() {
  const r = split.result;
  const n = r.stats.wallets;
  setText($('#legend-n'), n === 1 ? 'one wallet (same line)' : `split across ${n} wallets`);
  $('#split-result').replaceChildren(...L.resultSentences(r.stats).map((x) => h('li', { 'data-rule': x.rule, text: x.text })));
  $('#split-table thead th:nth-child(3)').textContent = n === 1 ? 'Same, one wallet' : `Same, ${n} wallets`;
  $('#split-table tbody').replaceChildren(...L.resultTable(r.stats).map((row, i) => h('tr', { 'data-rule': ['naive', 'per_wallet', 'loud'][i] },
    h('td', { text: row.label }),
    h('td', { text: row.single }),
    h('td', {}, row.split, row.note ? h('span', { class: 'sub', text: row.note }) : null),
    h('td', { text: row.drop1 }),
    h('td', {}, row.dropMax, row.note ? h('span', { class: 'sub', text: 'sale still running' }) : null),
  )));
  drawSplit();
}

function runSplit() {
  const form = $('#split-form');
  const wallets = Number(new FormData(form).get('wallets'));
  const shareBps = Number(new FormData(form).get('share'));
  if (!L.WALLET_CHOICES.includes(wallets) || !L.SHARE_CHOICES_BPS.includes(shareBps)) return;
  const btn = $('#split-run');
  btn.disabled = true;
  setText($('#split-status'), `Running ${wallets} wallet${wallets === 1 ? '' : 's'} under three rule sets, 6 engine hours each…`);
  // Let the status paint before the synchronous run.
  setTimeout(() => {
    const t0 = performance.now();
    try {
      split.result = L.runComparison({ wallets, shareBps }, split.cache);
      renderSplit();
      setText($('#split-status'), `Done: ${L.fmtBps(shareBps)} of supply, ${wallets} wallet${wallets === 1 ? '' : 's'}, computed in ${((performance.now() - t0) / 1000).toFixed(2)} s.`);
    } catch (e) {
      setText($('#split-status'), `The run failed: ${e.message}`);
    }
    btn.disabled = false;
  }, 30);
}

function initSplit() {
  $('#split-form').addEventListener('submit', (e) => {
    e.preventDefault();
    runSplit();
  });
  for (const b of document.querySelectorAll('.view button')) {
    b.addEventListener('click', () => {
      split.minutes = Number(b.dataset.minutes);
      for (const o of document.querySelectorAll('.view button')) o.setAttribute('aria-pressed', String(o === b));
      drawSplit();
    });
  }
  let raf = 0;
  let lastWidth = 0;
  new ResizeObserver(() => {
    const w = $('#plot-price').clientWidth;
    if (w === lastWidth) return;
    lastWidth = w;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(drawSplit);
  }).observe($('#plot-price'));
  runSplit();
}

// ---------------------------------------------------------------- sandbox

const HINTS = {
  E_NO_QUIET: 'Loud tokens cannot use sell. Shout them, wait for the notice, then leave.',
  E_NOTICE: 'Skip time with the clock buttons, then press Leave again.',
  E_EXPIRED: 'Press Hush to take the tokens back. They are still loud. Then shout again.',
  E_NO_LOUD: 'Shout takes loud tokens only. Quiet tokens can simply be sold.',
  E_DUST: 'A shout must be at least one millionth of supply, which is 1,000 LOUD here, unless it is your whole loud balance.',
  E_TOO_MANY: 'Hush or finish an exit first.',
  E_POOL_EMPTY: 'The pool does not hold enough NEAR to pay for this amount.',
  E_DEPOSIT: 'Buy with at least 0.001 NEAR.',
  E_AMOUNT: 'There is nothing to send or sell.',
  E_RECEIVER: 'The token account itself cannot receive tokens.',
};

const sb = { box: null, board: null, last: null };

function renderSandbox() {
  const v = sb.box.view();
  setText($('#sb-clock'), v.clock);
  setText($('#sb-window'), v.loudWindowText);
  setText($('#sb-account'), v.account);
  setText($('#sb-loud'), L.fmtTokens(v.loud));
  setText($('#sb-quiet'), L.fmtTokens(v.quiet));
  setText($('#sb-escrow'), L.fmtTokens(v.escrowed));
  setText($('#sb-near'), `${L.fmtNear(v.nearIn)} / ${L.fmtNear(v.nearOut)}`);
  setText($('#sb-other'), `${v.otherAccount} holds ${L.fmtTokens(v.otherLoud)} loud, ${L.fmtTokens(v.otherQuiet)} quiet.`);
  // The account column is hidden on narrow screens, so foreign rows say whose they are.
  sb.board.update(v.rows.map((r) => (r.mine ? r : { ...r, detail: `other wallet${r.detail ? `, ${r.detail}` : ''}` })),
    'No exits yet. Shout to list one.');
  setCap($('#sb-cap-bar'), $('#sb-cap-text'), v.capFraction, v.capText);
  setText($('#sb-cap-note'), v.nextRoomText
    ? `${v.nextRoomText}. The bucket refills to ${L.fmtTokens(v.capUnits)} LOUD over 60 min and is shared by every exit.`
    : `The bucket starts empty at launch, refills to ${L.fmtTokens(v.capUnits)} LOUD over 60 min, and is shared by every exit.`);

  const box = $('#sb-result');
  const e = sb.last;
  if (!e) {
    box.removeAttribute('data-ok');
    box.replaceChildren(h('p', { class: 'call', text: 'No call yet.' }));
  } else {
    box.dataset.ok = String(e.ok);
    let hint = e.ok ? '' : (HINTS[e.code] || '');
    if (e.code === 'E_CAP') hint = `${v.nextRoomText || 'Room is back'}. The cap is shared by every exit. Skip a few minutes and leave again.`;
    if (e.code === 'E_CAP') hint += ' The timestamp in the message is engine time in nanoseconds.';
    if (!e.ok && /units/.test(e.message)) hint += ' The engine counts in units: 1 LOUD is 10^18 units.';
    put(box,
      h('p', { class: 'call', text: `${L.fmtSinceLaunch(e.t)}  ${e.account}  ${e.call}  ${e.ok ? 'ok' : 'rejected'}` }),
      h('p', { class: 'msg', text: e.message }),
      hint ? h('p', { class: 'hint', text: hint.trim() }) : null,
    );
  }
  const log = $('#sb-log');
  log.replaceChildren(...v.log.slice().reverse().map((x) => h('li', { 'data-ok': String(x.ok), text: `${L.fmtSinceLaunch(x.t)}  ${x.account}  ${x.call}: ${x.message}` })));
  return v;
}

function sbDefaults(v) {
  const whole = (units) => (units / 10n ** 18n) * 10n ** 18n;
  if (whole(v.loud + v.quiet) > 0n) $('#sb-sell-in').value = L.tokensForInput(whole(v.loud + v.quiet));
  if (whole(v.loud) > 0n) $('#sb-shout-in').value = L.tokensForInput(whole(v.loud));
}

function initSandbox() {
  sb.box = new L.Sandbox();
  sb.board = createBoard($('#sb-table'), { actions: true });
  const act = (fn, defaults = false) => {
    sb.last = fn();
    const v = renderSandbox();
    if (defaults && sb.last && sb.last.ok) sbDefaults(v);
  };
  const root = $('#sandbox-body');
  for (const form of root.querySelectorAll('form[data-action]')) {
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const value = $('input', form).value;
      const kind = form.dataset.action;
      act(() => sb.box[kind](value), kind === 'buy');
    });
  }
  for (const b of root.querySelectorAll('[data-fill]')) {
    b.addEventListener('click', () => {
      const v = sb.box.view();
      const kind = b.dataset.fill;
      if (kind === 'quiet') $('#sb-sell-in').value = L.tokensForInput(v.quiet);
      if (kind === 'all') $('#sb-sell-in').value = L.tokensForInput(v.quiet + v.loud);
      if (kind === 'loud') $('#sb-shout-in').value = L.tokensForInput(v.loud);
    });
  }
  for (const b of root.querySelectorAll('[data-skip]')) {
    b.addEventListener('click', () => {
      sb.box.skip(BigInt(b.dataset.skip) * MIN_NS);
      renderSandbox();
    });
  }
  $('#sb-reset').addEventListener('click', () => {
    sb.box.reset();
    sb.last = null;
    $('#sb-buy-in').value = '10';
    renderSandbox();
  });
  $('#sb-split').addEventListener('click', () => act(() => sb.box.splitHalf(), true));
  $('#sb-switch').addEventListener('click', () => {
    sb.box.switchAccount();
    sbDefaults(renderSandbox());
  });
  $('#sb-table').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-do]');
    if (!b) return;
    const id = b.dataset.id;
    act(() => (b.dataset.do === 'leave' ? sb.box.leave(id) : sb.box.hush(id)), b.dataset.do === 'hush');
  });
  renderSandbox();
}

// ---------------------------------------------------------------- proof

function facts(dl, rows) {
  dl.replaceChildren(...rows.map((r) => h('div', {}, h('dt', { text: r.label ?? r[0] }), h('dd', {}, link(r.href ?? null, r.value ?? r[1])))));
}

function txList(txs) {
  const list = h('ol', { class: 'txs' });
  const details = h('details', {}, h('summary', { text: 'show transactions' }), list);
  // Step 9 can hold several hundred entries; build them when opened.
  details.addEventListener('toggle', () => {
    if (!details.open || list.childElementCount) return;
    list.replaceChildren(...txs.map((t) => h('li', { class: t.outcome === 'success' && !t.unsettled ? '' : 'bad' },
      link(t.href, t.short), ` ${L.shortAccount(t.account, 28)} ${t.round ? `round ${t.round} ` : ''}${t.label}${t.note ? `, ${t.note}` : ''}`,
      // Earlier broadcasts of a send that was signed again (newer proof runs only).
      ...t.earlier.flatMap((e, i) => [i === 0 ? '; earlier broadcast of this send: ' : ', ', link(e.href, e.short), ` ${e.label}`]))));
  });
  return details;
}

export function renderProof(dep, rec, loadError = '') {
  const d = L.deploymentView(dep);
  const depState = $('#dep-state');
  depState.dataset.state = d.state;
  setText(depState, loadError ? `Pending. The data files could not be loaded (${loadError}).` : d.headline);
  facts($('#dep-facts'), d.rows);

  const r = L.receiptsView(rec);
  const recState = $('#rec-state');
  recState.dataset.state = r.state;
  setText(recState, r.error ? `${r.headline} The run stopped early: ${r.error}` : r.headline);

  const sp = $('#split-proof-state');
  sp.dataset.state = r.split.result === 'PASS' ? 'ok' : r.split.result === 'FAIL' ? 'failed' : 'pending';
  setText(sp, r.split.have ? `${r.split.result}. ${r.split.sentence}` : r.split.sentence);
  if (r.split.have) facts($('#split-proof-facts'), r.split.rows);
  else $('#split-proof-facts').replaceChildren();

  const tbody = $('#steps-table tbody');
  if (r.steps.length) {
    tbody.replaceChildren(...r.steps.map((st) => h('tr', {},
      h('td', {}, `${st.n}. ${st.title}`, st.txs.length ? h('div', { class: 'fine', text: st.txSummary }) : null, st.txs.length ? txList(st.txs) : null),
      h('td', { 'data-label': 'Expected', text: st.expect }),
      h('td', { 'data-label': 'Got' }, st.got, st.gotNote ? h('div', { class: 'fine', text: st.gotNote }) : null),
      h('td', { class: 'res', 'data-label': 'Result', 'data-result': st.result, text: st.result }),
    )));
  } else {
    for (const tr of tbody.rows) {
      ['', 'Expected', 'Got', 'Result'].forEach((label, i) => { if (label && tr.cells[i]) tr.cells[i].dataset.label = label; });
    }
  }
  const stamp = r.generatedAt || d.generatedAt;
  if (stamp) setText($('#proof-meta'), `Recorded ${stamp}. The on-chain run uses the demo preset so it fits in one CI job: launch window 2 min, notice 1 min, exit window 10 min, cap 0.5% per 10 min. The script runs step 3 before step 2, so the launch window is not spent on creating accounts.`);
  return { deployment: d, receipts: r };
}

async function loadLive(token) {
  const state = $('#live-state');
  $('#live').hidden = false;
  state.dataset.state = 'pending';
  setText(state, 'Reading get_params, get_state and get_exits from NEAR testnet RPC…');
  const btn = $('#src-live');
  try {
    const live = await L.fetchLive(window.fetch.bind(window), token);
    hero.live = live;
    state.dataset.state = 'ok';
    setText(state, L.liveSummary(live, token));
    facts($('#live-facts'), L.liveFacts(live).map(([label, value]) => ({ label, value })));
    btn.disabled = false;
    setText(btn, 'Testnet: snapshot');
    if (hero.source === 'live') heroSetSource('live');
  } catch (e) {
    state.dataset.state = 'failed';
    const kept = hero.live
      ? ` The board and the facts below still show the earlier snapshot (chain time ${L.fmtUtcDate(hero.live.state.now)} ${L.fmtUtcTime(hero.live.state.now)} UTC).`
      : '';
    setText(state, `Could not read the token from NEAR testnet RPC in this browser (${e.message}).${kept} The receipts below do not depend on it.`);
    if (!hero.live) setText(btn, 'Testnet: unreachable');
  }
}

async function getJson(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

async function initProof() {
  let dep = null;
  let rec = null;
  let err = '';
  try {
    [dep, rec] = await Promise.all([getJson('deployment.json'), getJson('receipts.json')]);
  } catch (e) {
    err = e.message;
  }
  const { deployment } = renderProof(dep, rec, err);
  const repo = L.repoFromLocation(location.hostname, location.pathname) || (deployment.repo ? `https://github.com/${deployment.repo}` : null);
  if (repo) {
    const a = $('#repo-link');
    a.href = repo;
    a.hidden = false;
  }
  if (deployment.token) {
    $('#live-refresh').addEventListener('click', () => loadLive(deployment.token));
    await loadLive(deployment.token);
  }
}

// ---------------------------------------------------------------- start

function safely(name, fn) {
  try {
    const out = fn();
    if (out && typeof out.catch === 'function') out.catch((e) => console.error(name, e));
  } catch (e) {
    console.error(name, e);
  }
}

safely('board', initHero);
safely('sandbox', initSandbox);
safely('split', initSplit);
safely('proof', initProof);
