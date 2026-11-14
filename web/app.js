// Page wiring for LOUD. All rules live in engine.js; all DOM-free logic and
// formatting live in ui-logic.js. This file only reads inputs and writes DOM.
// Data from JSON files and RPC is written with textContent, never as HTML.

import * as L from './ui-logic.js';
import * as TL from './live-ui.js';

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

// Board

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
function createBoard(table, { actions = false, part = { kind: 'catch-half', text: 'Catch half', aria: 'Catch half of exit' } } = {}) {
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
        const actKey = `${row.canLeave}/${row.canHush}/${Boolean(row.canCatch)}`;
        if (actKey !== e.actKey) {
          e.actKey = actKey;
          put(e.act,
            row.canLeave ? h('button', { type: 'button', 'data-do': 'leave', 'data-id': row.id, text: 'Leave', 'aria-label': `Leave exit ${row.id}` }) : null,
            row.canHush ? h('button', { type: 'button', 'data-do': 'hush', 'data-id': row.id, text: 'Hush', 'aria-label': `Hush exit ${row.id}` }) : null,
            row.canCatch ? h('button', { type: 'button', 'data-do': 'catch', 'data-id': row.id, text: 'Catch', 'aria-label': `Catch all of exit ${row.id}` }) : null,
            row.canCatch ? h('button', { type: 'button', 'data-do': part.kind, 'data-id': row.id, text: part.text, 'aria-label': `${part.aria} ${row.id}` }) : null,
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

// Hero board

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
  heroScope(view, view.total ? `${L.boardScope(view)} Simulated exits.` : '');
  setText($('#board-clock-label'), 'Sim clock');
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
    'No open exits on chain in this snapshot. The contract stores open exits only, so finished ones are not listed here.',
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

// Same text as the static note in index.html.
const SIM_NOTE = 'Simulation: a creator splits a 5% bag across 36 wallets and sells it in batches. One minute passes every 0.4 s.';

function heroSetSource(source) {
  hero.source = source;
  $('#src-sim').setAttribute('aria-pressed', String(source === 'sim'));
  $('#src-live').setAttribute('aria-pressed', String(source === 'live'));
  $('#hero-pause').hidden = source !== 'sim';
  $('#hero-step').hidden = source !== 'sim';
  $('#hero-refresh').hidden = source !== 'live';
  setText($('#board-mode'), source === 'sim' ? 'simulation' : 'testnet snapshot');
  if (source === 'sim') {
    setText($('#hero-note'), SIM_NOTE);
    heroRenderSim();
  } else {
    const b = hero.live ? hero.live.block : null;
    setText($('#hero-note'), `Snapshot of the token on NEAR testnet${b && b.pinned ? ` at block ${b.height}` : ''}, demo preset. It does not update on its own. Times are block times, UTC.`);
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

// Charts

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
    minutes <= 60 ? 'minutes after the launch window ends' : 'hours after the launch window ends'));
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
  svg.setAttribute('aria-label', `Price after ${minutes} minutes as a share of the price at minute 0: ${lines.map((ln) => `${ln.name} ${Math.round(ln.pts.at(-1)[1] * 100)}%`).join(', ')}.`);
  container.replaceChildren(svg);
}

// Split attack

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
  $('#split-headlines').replaceChildren(...L.resultHeadlines(r.stats).map((x) => h('li', { 'data-rule': x.rule },
    h('span', { class: 'v-rule', text: x.name }),
    h('b', { class: 'v-line', text: x.line }),
    h('span', { class: 'v-sub', text: x.sub }))));
  $('#split-result').replaceChildren(...L.resultSentences(r.stats).map((x) => h('li', { 'data-rule': x.rule, text: x.text })));
  const nWallets = n === 1 ? 'one wallet' : `${n} wallets`;
  $('#split-table thead th:nth-child(3)').textContent = `Same, ${nWallets}`;
  $('#split-table thead th:nth-child(4)').textContent = `Price fall after 1 min, ${nWallets}`;
  $('#split-table thead th:nth-child(5)').textContent = `Largest price fall in ${L.fmtDuration(r.stats.horizonSec)}, ${nWallets}`;
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
  setText($('#split-status'), `Running ${wallets} wallet${wallets === 1 ? '' : 's'} under three rule sets, 6 simulated hours each…`);
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

// Sandbox

const HINTS = {
  E_NO_QUIET: 'Loud tokens cannot be sold directly. Shout them, wait for the notice, then leave.',
  E_NOTICE: 'Skip time with the clock buttons, then press Leave again.',
  E_EXPIRED: 'Press Hush to take the tokens back. They are still loud. Then shout again.',
  E_SELF: 'You cannot catch your own exit. Switch wallet and catch it from there.',
  E_DEPOSIT: 'A catch costs the higher of the pool\'s price now and its price when the exit was shouted.',
  E_NOTICE_BINDING: 'The owner cannot cancel a shout. Leave when the notice is over, or skip past the exit window and hush then.',
  E_NO_LOUD: 'Shout takes loud tokens only. Quiet tokens can simply be sold.',
  E_DUST: 'A shout must be at least one millionth of supply, which is 1,000 LOUD here. A smaller shout must be your whole loud balance, with no other exit of yours open.',
  E_TOO_MANY: 'Finish an exit, or let one expire and hush it.',
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
    ? `${v.nextRoomText}. Every exit shares this cap.`
    : `The cap starts empty at launch and refills to ${L.fmtTokens(v.capUnits)} LOUD over 60 min. Every exit shares it.`);
  const next = v.path.indexOf(false);
  [...$('#sb-path').children].forEach((li, i) => {
    li.dataset.done = String(v.path[i]);
    if (i === next) li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
  });

  const box = $('#sb-result');
  const e = sb.last;
  if (!e) {
    box.removeAttribute('data-ok');
    box.replaceChildren(h('p', { class: 'call', text: 'No call yet.' }));
  } else {
    box.dataset.ok = String(e.ok);
    let hint = e.ok ? '' : (HINTS[e.code] || '');
    if (e.code === 'E_CAP') hint = `${v.nextRoomText || 'Room is back'}. Skip a few minutes and leave again.`;
    if (!e.ok && e.call.startsWith('catch')) {
      hint = e.code === 'E_EXPIRED' ? 'An expired exit can no longer be caught. Hush returns its tokens to the owner.'
        : e.code === 'E_AMOUNT' ? 'There is nothing left in this exit to catch.'
          : e.code === 'E_DUST' ? 'A catch cannot leave less than one millionth of supply, 1,000 LOUD here, in the exit. Catch all of it.' : hint;
    }
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
    const kind = b.dataset.do;
    if (kind === 'catch' || kind === 'catch-half') act(() => sb.box.catch(id, kind === 'catch' ? 'all' : 'half'), true);
    else act(() => (kind === 'leave' ? sb.box.leave(id) : sb.box.hush(id)), kind === 'hush');
  });
  renderSandbox();
}

// Use it on testnet: real transactions through chain.js

const tr = {
  chain: null, cfg: null, store: { wallets: [], active: 0 }, live: null, board: null,
  last: null, log: [], busy: false, storageOk: true, lastRead: 0, readError: '',
};

function trLoadStore() {
  try {
    tr.store = TL.parseWallets(window.localStorage.getItem(TL.WALLET_KEY));
  } catch {
    tr.storageOk = false;
  }
}

function trSaveStore() {
  try {
    window.localStorage.setItem(TL.WALLET_KEY, TL.serializeWallets(tr.store));
  } catch {
    tr.storageOk = false;
  }
}

const trWallet = () => tr.store.wallets[tr.store.active] || null;
const trAccount = (id) => (tr.live ? tr.live.accounts.find((a) => a.accountId === id) : null) || null;

function trBusy(on, text = 'Waiting for NEAR testnet…') {
  tr.busy = on;
  const pending = $('#try-pending');
  pending.hidden = !on;
  setText(pending, text);
  for (const b of $('#try-body').querySelectorAll('button, input')) b.disabled = on;
}

function trRenderBoard() {
  if (!tr.live) return;
  const now = TL.chainNow(tr.live);
  const w = trWallet();
  const rows = TL.liveRows(tr.live.exits, now, w ? w.accountId : '', tr.store.wallets.map((x) => x.accountId));
  tr.board.update(rows, 'No open exits on the token right now. Shout to list one.');
  const cap = TL.capView(tr.live, now);
  setCap($('#try-cap-bar'), $('#try-cap-text'), cap.fraction, cap.text);
}

function trRender() {
  const live = tr.live;
  const w = trWallet();
  const count = tr.store.wallets.length;
  $('#try-new').hidden = count > 0;
  $('#try-new-2').hidden = count !== 1;
  $('#try-new-2-note').hidden = count !== 1;
  $('#try-switch').hidden = count < 2;
  $('#try-forget').hidden = count === 0;
  $('#try-import').hidden = count >= 2;
  $('#try-account').hidden = !w;
  $('#try-actions').hidden = !w;
  if (live) {
    facts($('#try-facts'), TL.liveHeader(live, tr.cfg).map(([label, value], i) => ({ label, value, href: i === 0 && !tr.chain.isMock ? tr.cfg.tokenHref : null })));
    setText($('#try-note'), TL.demoNote(live));
  }
  if (count === 1) {
    const route = TL.secondWalletRoute(tr.store.wallets[0], trAccount(tr.store.wallets[0].accountId));
    setText($('#try-new-2-note'), route === 'sub'
      ? 'Wallet B is made from wallet A with 3 of its test NEAR, in one transaction. No faucet needed.'
      : 'Wallet A holds too little test NEAR to fund wallet B, so the faucet is asked instead.');
  }
  if (w) {
    const a = trAccount(w.accountId);
    setText($('#try-wallet-label'), TL.walletLabel(tr.store.active));
    put($('#try-acct'), link(tr.chain.accountUrl(w.accountId), w.accountId));
    setText($('#try-near'), a ? (a.exists ? L.fmtNear(a.near) : 'being created…') : '…');
    setText($('#try-loud'), a ? L.fmtTokens(a.loud) : '…');
    setText($('#try-quiet'), a ? L.fmtTokens(a.quiet) : '…');
    setText($('#try-escrow'), a ? L.fmtTokens(a.escrowed) : '…');
    $('#try-first').hidden = !a || a.registered;
    const claim = $('#try-claim');
    claim.hidden = !a || a.owed <= 0n;
    if (a && a.owed > 0n) setText(claim, `Claim ${L.fmtNear(a.owed, 6)} NEAR owed to this wallet`);
    const other = tr.store.wallets[1 - tr.store.active];
    const o = other ? trAccount(other.accountId) : null;
    $('#try-other').hidden = !other;
    if (other) {
      setText($('#try-other'), `${TL.walletLabel(1 - tr.store.active)} (${L.shortAccount(other.accountId, 30)}) holds ${o ? L.fmtNear(o.near) : '…'} NEAR, ${o ? L.fmtTokens(o.loud) : '…'} loud, ${o ? L.fmtTokens(o.quiet) : '…'} quiet.`);
    }
  } else {
    $('#try-other').hidden = true;
    $('#try-claim').hidden = true;
  }
  setText($('#try-wallet-note'), `${tr.storageOk ? '' : 'This browser blocks storage, so a wallet lasts only until this tab is closed. '}A test wallet is a new NEAR testnet account that the public faucet funds with test NEAR. Testnet only, throwaway, no real funds. Its key is made in this browser, kept in this browser's storage and never sent anywhere. A second wallet lets you catch your own exit from another account.`);
  trRenderBoard();
  setText($('#try-board-note'), TL.boardNote(live, tr.readError, tr.chain.isMock ? 'the mock, not a chain,' : 'NEAR testnet'));

  const box = $('#try-result');
  const e = tr.last;
  if (!e) {
    box.removeAttribute('data-ok');
    box.replaceChildren(h('p', { class: 'call', text: 'No transaction yet.' }));
  } else {
    box.dataset.ok = e.unknown ? 'unknown' : String(e.ok);
    put(box,
      h('p', { class: 'call', text: e.call }),
      h('p', { class: 'msg', text: e.message }),
      e.hint ? h('p', { class: 'hint', text: e.hint }) : null,
      e.explorerUrl ? h('p', { class: 'hint' }, link(e.explorerUrl, 'View transaction in the explorer')) : null,
      !e.explorerUrl && e.hash && tr.chain.isMock ? h('p', { class: 'hint', text: `Mock transaction ${L.shortHash(e.hash)}: invented, not on any chain.` }) : null,
    );
  }
  const log = $('#try-log');
  log.replaceChildren(...tr.log.slice().reverse().map((x) => h('li', { 'data-ok': x.unknown ? 'unknown' : String(x.ok) },
    document.createTextNode(`${x.call}: ${x.message} `),
    x.explorerUrl ? link(x.explorerUrl, `transaction ${L.shortHash(x.hash)}`)
      : x.hash && tr.chain.isMock ? document.createTextNode(`(mock ${L.shortHash(x.hash)}, no explorer link)`) : null)));
  if (tr.log.length > 0) $('#try-log-box').open = true;
}

async function trRefresh() {
  try {
    tr.live = await TL.readLive(tr.chain, tr.cfg.token, tr.store.wallets.map((w) => w.accountId));
    tr.readError = '';
  } catch (e) {
    tr.readError = e && e.message ? e.message : String(e);
    if (!tr.live) throw e;
  }
  tr.lastRead = Date.now();
  trRender();
}

function trNote(ok, call, message, hint = '') {
  tr.last = { ok, call, message, hint, explorerUrl: null, hash: null };
}

// Sends one transaction and shows what came back. `build` returns
// { kind, ctx, method, args, gasTgas, depositYocto } or throws a message for the visitor.
async function trSend(build) {
  if (tr.busy) return;
  const w = trWallet();
  if (!w) return;
  trBusy(true);
  let ctx = { accountId: w.accountId, call: '' };
  let plan = null;
  let res = null;
  try {
    plan = await build(w, trAccount(w.accountId));
    ctx = { accountId: w.accountId, ...plan.ctx };
    // chain.call throws only before it has broadcast anything. A send it could not
    // confirm comes back as outcome "unknown", with its hash.
    res = await tr.chain.call(w, tr.cfg.token, plan.method, plan.args, { gasTgas: plan.gasTgas ?? TL.GAS_DEFAULT, depositYocto: plan.depositYocto });
  } catch (e) {
    trNote(false, `${ctx.accountId}  ${ctx.call || 'not sent'}`, e && e.message ? e.message : String(e), 'Nothing was sent to the chain.');
  }
  // From here on a transaction exists: whatever fails below keeps its hash and link.
  if (res) {
    try {
      if (plan.kind === 'leave' && res.ok) ctx.after = await trAfterLeave(res);
    } catch {
      ctx.after = null;
    }
    try {
      tr.last = TL.describeResult(plan.kind, ctx, res);
    } catch (e) {
      tr.last = {
        ok: Boolean(res.ok), unknown: res.outcome === 'unknown', call: `${ctx.accountId}  ${ctx.call}  ${res.outcome}`,
        message: `The transaction ${res.outcome === 'unknown' ? 'was sent and may still execute' : `ended as ${res.outcome}`}; the page could not word its result (${e && e.message ? e.message : e}).`,
        hint: 'The explorer shows what happened.', explorerUrl: res.explorerUrl || null, hash: res.hash || null,
      };
    }
    tr.log.push(tr.last);
  }
  const bought = Boolean(tr.last && tr.last.ok && ctx.call.startsWith('buy '));
  try {
    await trRefresh();
  } catch {
    trRender();
  }
  // After a buy the shout field holds the whole loud balance: shouted, it is one exit
  // larger than the cap, so the walkthrough ends in a partial leave.
  if (bought) {
    const a = trAccount(w.accountId);
    if (a && a.loud > 0n) $('#try-shout-in').value = L.tokensForInput(a.loud);
  }
  trBusy(false);
}

// Why a leave filled only part of the exit: get_state read until it includes the call
// (leave_count has grown), and quote_sell of what is left, up to the cap room.
async function trAfterLeave(res) {
  const ev = (res.events || []).find((e) => e.standard === 'loud' && e.event === 'leave');
  if (!ev || !tr.live || String(ev.data.remaining) === '0') return null;
  const before = tr.live.state.leave_count;
  for (let i = 0; i < 5; i++) {
    try {
      const st = await tr.chain.view(tr.cfg.token, 'get_state', {});
      if (BigInt(st.leave_count) > before) {
        const rest = BigInt(ev.data.remaining);
        const room = BigInt(st.cap_available);
        const quoteForRest = await tr.chain.view(tr.cfg.token, 'quote_sell', { amount: (rest < room ? rest : room).toString() });
        return { capAvailable: st.cap_available, capUnits: st.cap_units, poolNear: st.pool_near, quoteForRest };
      }
    } catch {
      return null;
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  return null;
}

const trNeed = (a) => {
  if (!a) throw new Error('The wallet is still loading. Try again in a moment.');
  if (!a.exists) throw new Error('The faucet is still creating this account. Try again in a few seconds.');
  return a;
};

function trBuy(text) {
  return trSend(async (w, a) => {
    const plan = TL.buyPlan(text, trNeed(a));
    if (plan.error) throw new Error(plan.error);
    const quote = await tr.chain.view(tr.cfg.token, 'quote_buy', { near: plan.intoPool.toString() });
    return {
      kind: 'buy', method: 'buy', args: TL.buyArgs(plan, quote), depositYocto: plan.deposit.toString(),
      ctx: { call: `buy with ${L.fmtNear(plan.deposit)} NEAR`, deposit: plan.deposit, storage: plan.storage, loud: tr.live.state.is_loud_window === true },
    };
  });
}

function trSell(text) {
  return trSend(async (w, a) => {
    trNeed(a);
    const amount = TL.tokenAmount(text);
    return { kind: 'sell', method: 'sell', args: { amount: amount.toString(), min_near_out: '0' }, depositYocto: '1', ctx: { call: `sell ${L.fmtTokens(amount)} LOUD`, amount } };
  });
}

function trShout(text) {
  return trSend(async (w, a) => {
    trNeed(a);
    const amount = TL.tokenAmount(text);
    return {
      kind: 'shout', method: 'shout', args: { amount: amount.toString() }, depositYocto: '1',
      ctx: { call: `shout ${L.fmtTokens(amount)} LOUD`, amount, noticeSec: L.nsToSeconds(tr.live.params.notice_ns) },
    };
  });
}

function trExit(id) {
  const ex = tr.live ? tr.live.exits.find((x) => x.id.toString() === id) : null;
  if (!ex) throw new Error('This exit is no longer open.');
  return ex;
}

function trLeaveOrHush(kind, id) {
  return trSend(async (w, a) => {
    trNeed(a);
    const ex = trExit(id);
    const args = kind === 'leave' ? { exit_id: id, min_near_out: '0' } : { exit_id: id };
    return { kind, method: kind, args, depositYocto: '1', ctx: { call: `${kind} exit ${id}`, remaining: ex.remaining } };
  });
}

async function trCatch(id, part) {
  const w = trWallet();
  const a = w ? trAccount(w.accountId) : null;
  // An unregistered wallet pays its storage first, in its own transaction.
  if (w && a && a.exists && !a.registered) {
    await trSend(async () => ({
      kind: 'register', method: 'storage_deposit', args: {}, depositYocto: TL.STORAGE_FEE.toString(),
      ctx: { call: 'storage_deposit 0.03 NEAR' },
    }));
    if (!tr.last || !tr.last.ok) return;
  }
  await trSend(async (w2, a2) => {
    trNeed(a2);
    const ex = trExit(id);
    const amount = part === 'all' ? ex.remaining : TL.quarterOf(ex.remaining, tr.live.params.total_supply);
    const quote = await tr.chain.view(tr.cfg.token, 'quote_catch', { exit_id: id, amount: amount.toString() });
    const plan = TL.catchPlan(quote, a2);
    if (plan.error) throw new Error(plan.error);
    return {
      kind: 'catch', method: 'catch', args: { exit_id: id, amount: amount.toString() }, gasTgas: TL.GAS_CATCH, depositYocto: plan.deposit.toString(),
      ctx: { call: `catch ${L.fmtTokens(amount)} LOUD of exit ${id}`, amount, exitId: id, price: plan.price, fee: plan.fee },
    };
  });
}

async function trHasEd25519() {
  try {
    await window.crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
    return true;
  } catch {
    return false;
  }
}

function trKeep(w) {
  tr.store.wallets.push({ accountId: w.accountId, publicKey: w.publicKey, secretKey: w.secretKey });
  tr.store.active = tr.store.wallets.length - 1;
  trSaveStore();
}

async function trCanSign() {
  if (tr.chain.isMock || (await trHasEd25519())) return true;
  trNote(false, 'test wallet  not created', TL.NO_ED25519);
  trRender();
  return false;
}

async function trAfterWallet() {
  try {
    await trRefresh();
  } catch {
    trRender();
  }
  trShoutDefault();
  trBusy(false);
}

// The shout field follows the active wallet: its whole loud balance, or the default.
function trShoutDefault() {
  const w = trWallet();
  const a = w ? trAccount(w.accountId) : null;
  $('#try-shout-in').value = a && a.loud > 0n ? L.tokensForInput(a.loud) : '1000000';
}

// The first wallet comes from the faucet. The second is made from wallet A in one
// transaction when A can fund it, so the faucet, which limits accounts per network
// address, is asked once per visitor.
async function trNewWallet() {
  if (tr.busy || tr.store.wallets.length >= 2 || !(await trCanSign())) return;
  const parent = tr.store.wallets.length === 1 ? tr.store.wallets[0] : null;
  const route = parent ? TL.secondWalletRoute(parent, trAccount(parent.accountId)) : 'faucet';
  if (route === 'sub') {
    trBusy(true, 'Wallet A is creating wallet B on NEAR testnet…');
    const call = `${parent.accountId}  create wallet B with 3 NEAR`;
    try {
      const w = await tr.chain.createSubWallet(parent, { amountYocto: TL.SUB_WALLET_NEAR.toString() });
      trKeep(w);
      tr.last = w.outcome === 'success'
        ? { ok: true, call: `${call}  ok`, message: `Wallet B (${w.accountId}) was made from wallet A with 3 of its test NEAR, in one transaction. Use it to catch wallet A's exit.`, hint: '', explorerUrl: w.explorerUrl || null, hash: w.hash || null }
        : { ok: false, unknown: true, call: `${call}  sent, not confirmed`, message: 'The transaction that creates wallet B was sent, but NEAR testnet did not confirm it in time. It may still execute. Wallet B is kept here and shows its balance once the account exists.', hint: 'Open it in the explorer before you try again.', explorerUrl: w.explorerUrl || null, hash: w.hash || null };
      tr.log.push(tr.last);
    } catch (e) {
      const r = e && e.result ? e.result : null;
      tr.last = {
        ok: false, call: `${call}  rejected`, message: e && e.message ? e.message : String(e),
        hint: r && r.hash ? 'The transaction ran and failed, so wallet B was not created.' : 'Wallet B was not created and no NEAR left wallet A.',
        explorerUrl: r ? r.explorerUrl || null : null, hash: r ? r.hash || null : null,
      };
      if (r && r.hash) tr.log.push(tr.last);
    }
    await trAfterWallet();
    return;
  }
  trBusy(true, 'Asking the testnet faucet for a funded account…');
  try {
    const w = await tr.chain.createTestWallet({ prefix: 'loud-try' });
    trKeep(w);
    trNote(true, `${w.accountId}  created`, `${TL.walletLabel(tr.store.active)} is a new testnet account funded by the faucet. Buy with it.`);
  } catch (e) {
    trNote(false, 'test wallet  not created', TL.faucetFailure(e));
  }
  await trAfterWallet();
}

// An existing testnet account: saved only after its key is found on it.
async function trImport(ev) {
  ev.preventDefault();
  if (tr.busy || tr.store.wallets.length >= 2 || !(await trCanSign())) return;
  const idIn = $('#try-import-id');
  const keyIn = $('#try-import-key');
  trBusy(true, 'Checking that this key is on the account…');
  try {
    const w = await tr.chain.importTestWallet(idIn.value, keyIn.value);
    if (tr.store.wallets.some((x) => x.accountId === w.accountId)) throw new Error(`${w.accountId} is already one of the wallets here.`);
    trKeep(w);
    keyIn.value = '';
    $('#try-import').open = false;
    trNote(true, `${w.accountId}  imported`, `${TL.walletLabel(tr.store.active)} is ${w.accountId}. Its key is on the account and is now kept in this browser's storage.`);
  } catch (e) {
    trNote(false, 'test wallet  not imported', e && e.message ? e.message : String(e));
  }
  await trAfterWallet();
}

async function trStart() {
  const state = $('#try-state');
  const retry = $('#try-retry');
  retry.hidden = true;
  state.dataset.state = 'pending';
  setText(state, 'Reading the live token from NEAR testnet…');
  try {
    await trRefresh();
    state.hidden = true;
    $('#try-app').hidden = false;
  } catch (e) {
    state.dataset.state = 'failed';
    setText(state, `Could not read the live token from NEAR testnet in this browser (${e && e.message ? e.message : e}).`);
    retry.hidden = false;
  }
}

async function initTry() {
  const state = $('#try-state');
  const mock = new URLSearchParams(location.search).get('mock') === '1';
  let json = null;
  if (mock) {
    const banner = $('#try-mock');
    setText(banner, TL.MOCK_BANNER);
    banner.hidden = false;
    tr.chain = TL.createMockChain();
    window.loudMock = tr.chain;
    json = TL.mockLiveJson();
  } else {
    try {
      json = await getJson('live.json');
    } catch {
      json = null;
    }
  }
  tr.cfg = TL.liveConfig(json);
  if (!tr.cfg) {
    state.dataset.state = 'failed';
    setText(state, 'The live token is not deployed yet.');
    return;
  }
  if (!mock) {
    try {
      tr.chain = await import('./chain.js');
    } catch (e) {
      state.dataset.state = 'failed';
      setText(state, `The wallet code did not load in this browser (${e && e.message ? e.message : e}).`);
      return;
    }
  }
  trLoadStore();
  tr.board = createBoard($('#try-table'), { actions: true, part: { kind: 'catch-quarter', text: 'Catch quarter', aria: 'Catch a quarter of exit' } });
  const root = $('#try-body');
  $('#try-retry').addEventListener('click', trStart);
  $('#try-new').addEventListener('click', trNewWallet);
  $('#try-new-2').addEventListener('click', trNewWallet);
  $('#try-import-form').addEventListener('submit', trImport);
  $('#try-claim').addEventListener('click', () => trSend(async (w, a) => {
    trNeed(a);
    return { kind: 'claim', method: 'claim', args: {}, depositYocto: '1', ctx: { call: 'claim' } };
  }));
  $('#try-switch').addEventListener('click', () => {
    if (tr.busy || tr.store.wallets.length < 2) return;
    tr.store.active = 1 - tr.store.active;
    trSaveStore();
    trShoutDefault();
    trRender();
  });
  $('#try-forget').addEventListener('click', () => {
    const w = trWallet();
    if (tr.busy || !w) return;
    if (!window.confirm(`Forget ${w.accountId}? Its key is deleted from this browser and cannot be recovered.`)) return;
    tr.store.wallets.splice(tr.store.active, 1);
    tr.store.active = 0;
    trSaveStore();
    trNote(true, `${w.accountId}  forgotten`, 'The key is deleted from this browser. The account stays on testnet.');
    trRefresh().catch(() => trRender());
  });
  for (const form of root.querySelectorAll('form[data-try]')) {
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const value = $('input', form).value;
      const kind = form.dataset.try;
      if (kind === 'buy') trBuy(value);
      else if (kind === 'sell') trSell(value);
      else trShout(value);
    });
  }
  for (const b of root.querySelectorAll('[data-try-fill]')) {
    b.addEventListener('click', () => {
      const w = trWallet();
      const a = w ? trAccount(w.accountId) : null;
      if (!a) return;
      // Exact balances: a shout of the whole loud balance is accepted even below the
      // contract's minimum size.
      if (b.dataset.tryFill === 'all') $('#try-sell-in').value = L.tokensForInput(a.loud + a.quiet);
      else $('#try-shout-in').value = L.tokensForInput(a.loud);
    });
  }
  $('#try-table').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-do]');
    if (!b || tr.busy) return;
    const id = b.dataset.id;
    const kind = b.dataset.do;
    if (kind === 'catch') trCatch(id, 'all');
    else if (kind === 'catch-quarter') trCatch(id, 'quarter');
    else trLeaveOrHush(kind, id);
  });
  await trStart();
  // Countdowns move every second; the chain is read again every 10 s while the tab is visible.
  setInterval(() => {
    if (!tr.live || tr.busy || document.visibilityState !== 'visible') return;
    if (Date.now() - tr.lastRead >= 10000) {
      tr.lastRead = Date.now();
      trRefresh().catch(() => trRender());
    } else {
      trRenderBoard();
    }
  }, 1000);
}

// Proof

function facts(dl, rows) {
  dl.replaceChildren(...rows.map((r) => h('div', {}, h('dt', { text: r.label ?? r[0] }), h('dd', {}, link(r.href ?? null, r.value ?? r[1])))));
}

// What one check expected, what the run recorded and its transactions, folded
// under the check's title.
function stepRecord(st) {
  const list = h('ol', { class: 'txs' });
  const labelled = (label, value) => h('p', {}, h('b', { text: `${label} ` }), value);
  const details = h('details', {},
    h('summary', { text: st.txs.length ? `Expected, recorded, ${st.txs.length} transaction${st.txs.length === 1 ? '' : 's'}` : 'Expected and recorded' }),
    labelled('Expected', st.expect),
    labelled('Recorded', st.got),
    st.gotNote ? h('p', { text: st.gotNote }) : null,
    st.txs.length ? h('p', { text: st.txSummary }) : null,
    st.txs.length ? list : null);
  // One check can hold several hundred transactions; build them when opened.
  details.addEventListener('toggle', () => {
    if (!details.open || list.childElementCount) return;
    list.replaceChildren(...st.txs.map((t) => h('li', { class: t.outcome === 'success' && !t.unsettled ? '' : 'bad' },
      link(t.href, t.short), ` ${L.shortAccount(t.account, 28)} ${t.call ? `${t.call} ` : ''}${t.round ? `round ${t.round} ` : ''}${t.label}${t.note ? `, ${t.note}` : ''}`,
      // Earlier broadcasts of a send that was signed again (newer proof runs only).
      ...t.earlier.flatMap((e, i) => [i === 0 ? '; earlier broadcast of this send: ' : ', ', link(e.href, e.short), ` ${e.label}`]))));
  });
  return details;
}

export function renderProof(dep, rec, loadError = '') {
  const d = L.deploymentView(dep);
  const r = L.receiptsView(rec);
  const recState = $('#rec-state');
  // index.html already carries the recorded run. If the files cannot be read,
  // that text stays and one line says the details are missing.
  if (loadError) {
    recState.dataset.state = 'pending';
    recState.hidden = false;
    setText(recState, `The data files could not be read (${loadError}). This page shows the recorded run as saved with it, without the transaction lists.`);
    return { deployment: d, receipts: r };
  }
  const depState = $('#dep-state');
  depState.dataset.state = d.state;
  setText(depState, d.headline);
  facts($('#dep-facts'), d.rows);

  const heads = L.proofHeadlines(d, r);
  $('#proof-facts').replaceChildren(...heads.map((x) => h('li', { 'data-state': x.state },
    h('b', { text: x.big }),
    h('span', { text: x.small }),
    x.href ? h('a', { href: x.href, rel: 'noopener', text: x.linkText }) : null)));
  if (d.token) put($('#sum-token'), link(d.tokenHref, d.token));
  else setText($('#sum-token'), 'Not deployed yet.');
  put($('#sum-proof'), `${heads[0].big}. ${heads[2].big} ${r.scopeNote ? 'Recorded before two later rules, listed under Testnet proof. ' : ''}`,
    heads[0].href ? h('a', { href: heads[0].href, rel: 'noopener', text: heads[0].linkText }) : null);

  // The large line already says a clean pass; the sentence is shown when it adds something.
  recState.dataset.state = r.state;
  recState.hidden = r.state === 'ok' && r.unresolved === 0 && !r.error;
  setText(recState, r.error ? `${r.headline} The run stopped early: ${r.error}` : r.headline);

  const scope = $('#proof-scope');
  scope.hidden = !r.scopeNote;
  setText(scope, r.scopeNote);
  const caught = $('#proof-catch');
  caught.hidden = !r.caught.have;
  if (r.caught.have) put(caught, `${r.caught.sentence} `, r.caught.href ? h('a', { href: r.caught.href, rel: 'noopener', text: r.caught.linkText }) : null);
  else caught.replaceChildren();
  $('#near-record').hidden = r.tokenNear.length === 0;
  facts($('#near-facts'), r.tokenNear);

  const sp = $('#split-proof-state');
  sp.dataset.state = r.split.result === 'PASS' ? 'ok' : r.split.result === 'FAIL' ? 'failed' : 'pending';
  setText(sp, r.split.have ? `${r.split.result}. ${r.split.sentence}` : r.split.sentence);
  if (r.split.have) facts($('#split-proof-facts'), r.split.rows);
  else $('#split-proof-facts').replaceChildren();

  if (r.steps.length) {
    const rows = (steps) => steps.map((st) => h('tr', {},
      h('td', {}, `${st.n}. ${st.title}`, stepRecord(st)),
      h('td', { class: 'res', 'data-result': st.result, text: st.result }),
    ));
    const { key, rest } = L.splitChecks(r.steps);
    $('#steps-key tbody').replaceChildren(...rows(key));
    $('#steps-table tbody').replaceChildren(...rows(rest));
    $('#steps-rest').hidden = rest.length === 0;
  }
  const stamp = r.generatedAt || d.generatedAt;
  if (stamp) setText($('#proof-stamp'), `Recorded ${stamp}.`);
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
    setText(btn, 'Testnet snapshot');
    if (hero.source === 'live') heroSetSource('live');
  } catch (e) {
    state.dataset.state = 'failed';
    const kept = hero.live
      ? ` The board and the facts below still show the earlier snapshot (chain time ${L.fmtUtcDate(hero.live.state.now)} ${L.fmtUtcTime(hero.live.state.now)} UTC).`
      : '';
    setText(state, `Could not read the token from NEAR testnet RPC in this browser (${e.message}).${kept} The recorded checks do not depend on it.`);
    if (!hero.live) setText(btn, 'Testnet unreachable');
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
  if (repo) for (const a of [$('#repo-link'), $('#sum-source')]) a.href = repo;
  if (deployment.token) {
    for (const b of [$('#live-refresh'), $('#hero-refresh')]) b.addEventListener('click', () => loadLive(deployment.token));
    await loadLive(deployment.token);
  }
}

// Start

function safely(name, fn) {
  try {
    const out = fn();
    if (out && typeof out.catch === 'function') out.catch((e) => console.error(name, e));
  } catch (e) {
    console.error(name, e);
  }
}

safely('board', initHero);
safely('try', initTry);
safely('sandbox', initSandbox);
safely('split', initSplit);
safely('proof', initProof);
