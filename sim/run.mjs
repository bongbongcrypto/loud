// 60-day community simulation for LOUD.
//
//   node sim/run.mjs                 full run, writes sim/results.json and sim/RESULTS.md
//   node sim/run.mjs --days 10 --seeds 2 --out some/dir
//
// Every scenario runs under three rule sets with the same pool math:
//   naive       no rule
//   per_wallet  max sell 0.5% of supply per transaction, 60 s cooldown per wallet
//   loud        shout -> notice -> leave under one global cap (web/engine.js)
// and LOUD runs under several choices of cap and notice.
//
// This is a model. The community behaviour below is assumed, not measured.
// All randomness comes from seeded generators, so the output reproduces.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  PRESETS, NEAR, SEC, MIN, HOUR, DAY, makeRng, makeToken, makeSeller, GreedyLoudSeller,
} from '../web/engine.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TICK = 60n * SEC;
const TICKS_PER_HOUR = 60;
const TICKS_PER_DAY = 1440;
const DROP_SKIP_HOURS = 12;

// ---- model assumptions (all in one place) ----
export const MODEL = Object.freeze({
  insiderWallets: 30, // the creator allocation is split across these
  bundleNear: 10, // NEAR the same wallets spend in the first block (launch window)
  buyRatePerHour: 1, // long-run community buy arrivals
  launchBuyRatePerHour: 30, // extra arrivals at launch, decaying
  launchDecayHours: 6,
  buyMedianNear: 0.2, // lognormal buy size
  buySigma: 1.2,
  buyMaxNear: 5,
  holdDays: 20, // mean holding time of an ordinary holder
  panicThreshold: 0.10, // 1-hour price drop that starts panic selling
  panicSlope: 20, // sell hazard multiplier added per further 10% drop
  panicMax: 200,
  boardThresholdBps: 30, // open exits above this share of supply count as a visible board
  rushPerPct: 0.1, // share of quiet holders who sell during the notice, per 1% of supply on the board
  rushMax: 0.3, // upper limit of that share
  boardQuietHours: 24, // a new board episode needs this long without a board
  shockShare: 0.4, // late panic: share of holders who sell within shockHours
  shockHours: 2,
  bleedDays: 20, // slow bleed: the insider sells 1/bleedDays of its holdings per day
});

export const SCENARIOS = Object.freeze({
  calm: 'Calm launch: early supply never sells',
  bundle_dump: 'Coordinated bundle dump at day 1',
  slow_bleed: 'Slow bleed: early supply sells 1/20 per day from day 2',
  late_panic: 'Late panic at day 30: 40% of holders sell within 2 hours and early supply dumps',
});

export const LOUD_VARIANTS = Object.freeze({
  tight: { cap_bps: 25n, notice_ns: 60n * MIN, label: 'cap 0.25%/h, notice 60 min' },
  standard: { cap_bps: 50n, notice_ns: 30n * MIN, label: 'cap 0.5%/h, notice 30 min' },
  long_notice: { cap_bps: 50n, notice_ns: 240n * MIN, label: 'cap 0.5%/h, notice 4 h' },
  loose: { cap_bps: 200n, notice_ns: 10n * MIN, label: 'cap 2%/h, notice 10 min' },
});

export const RULE_ROWS = Object.freeze([
  { rule: 'naive', variant: null, label: 'naive (no rule)' },
  { rule: 'per_wallet', variant: null, label: 'per_wallet (0.5%/tx, 60 s)' },
  ...Object.keys(LOUD_VARIANTS).map((v) => ({ rule: 'loud', variant: v, label: `loud ${v} (${LOUD_VARIANTS[v].label})` })),
]);

// An ordinary holder selling a quiet balance under LOUD. Like the baseline
// seller it sells what the pool can pay for now and keeps the rest for the
// next step, so an unfilled holder stays in the queue under every rule.
export class QuietSeller {
  constructor(token, name) {
    this.token = token;
    this.name = name;
    this.sold = 0n;
    this.near_out = 0n;
  }

  holdings() {
    return this.token.getAccount(this.name).quiet;
  }

  // Returns units sold during this step.
  step(now) {
    const token = this.token;
    const quiet = this.holdings();
    const cap = token.maxSellable();
    const x = quiet < cap ? quiet : cap;
    if (x === 0n || token.quoteSell(x) === 0n) return 0n;
    this.near_out += token.sell(this.name, x, 0n, now);
    this.sold += x;
    return x;
  }
}

function poisson(rng, lambda) {
  if (lambda <= 0) return 0;
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = rng();
  while (p > limit) {
    k++;
    p *= rng();
  }
  return k;
}

function normal(rng) {
  const u = 1 - rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function nearToYocto(x) {
  return BigInt(Math.round(x * 1e6)) * 10n ** 18n;
}

function yoctoToNear(y) {
  return Number(y / 10n ** 18n) / 1e6;
}

export function runScenario({ scenario, rule, variant = 'standard', days = 60, seed = 1, rushScale = 1 }) {
  if (!SCENARIOS[scenario]) throw new Error(`unknown scenario ${scenario}`);
  const v = rule === 'loud' ? LOUD_VARIANTS[variant] : null;
  const params = {
    ...PRESETS.standard,
    creator: 'insider-0',
    ...(v ? { cap_bps: v.cap_bps, notice_ns: v.notice_ns } : {}),
  };
  const token = makeToken(rule, params, 0n);
  const supply = token.total_supply;
  const refLot = supply / 10000n;
  const rngBuy = makeRng(seed * 7919 + 1);
  const rngSell = makeRng(seed * 7919 + 2);
  const rngRush = makeRng(seed * 7919 + 3);
  const rngShock = makeRng(seed * 7919 + 4);

  // Early supply: creator allocation plus a first-block bundle, in 30 wallets.
  const wallets = Array.from({ length: MODEL.insiderWallets }, (_, i) => `insider-${i}`);
  const bundleEach = nearToYocto(MODEL.bundleNear) / BigInt(wallets.length - 1);
  for (const w of wallets.slice(1)) token.buy(w, bundleEach, 0n, 0n);
  const share = token.creator_alloc / BigInt(wallets.length);
  for (const w of wallets.slice(1)) {
    if (rule === 'loud') token.transferLoud(wallets[0], w, share, 0n);
    else token.transfer(wallets[0], w, share, 0n);
  }
  const insider = makeSeller(rule, token, wallets, TICK);
  const earlySupply = insider.holdings();

  const totalTicks = days * TICKS_PER_DAY;
  const price = new Float64Array(totalTicks + 1);
  const exitPx = new Float64Array(totalTicks + 1);
  price[0] = token.price();
  exitPx[0] = token.exitPrice(refLot);

  const holders = []; // names of ordinary holders that still hold tokens
  const exiting = []; // sellers that need more than one transaction
  const scheduled = new Map(); // tick -> holder names that sell at that tick
  let holderCount = 0;
  let insiderStartTick = null;
  let signalTick = null; // first public sign of early supply selling
  let exitDoneTick = null;
  let boardActive = false;
  let boardLastSeen = -Infinity;
  let bleedTarget = 0n;
  const series = [];

  const dumpStart = scenario === 'bundle_dump' ? TICKS_PER_DAY
    : scenario === 'late_panic' ? 30 * TICKS_PER_DAY
      : scenario === 'slow_bleed' ? 2 * TICKS_PER_DAY : null;

  function removeHolder(name) {
    const i = holders.indexOf(name);
    if (i >= 0) {
      holders[i] = holders[holders.length - 1];
      holders.pop();
    }
  }

  function startExit(name, t) {
    removeHolder(name);
    if (rule === 'loud') {
      const acc = token.getAccount(name);
      if (acc.quiet > 0n) {
        const s = new QuietSeller(token, name);
        s.step(t);
        if (s.holdings() > 0n) exiting.push(s);
      }
      if (acc.loud >= token.dust_units) {
        const s = new GreedyLoudSeller(token, [name], TICK);
        s.step(t);
        exiting.push(s);
      }
    } else {
      const s = makeSeller(rule, token, [name], TICK);
      s.step(t);
      if (s.holdings() > 0n) exiting.push(s);
    }
  }

  function schedule(tick, name) {
    if (tick > totalTicks) return;
    if (!scheduled.has(tick)) scheduled.set(tick, []);
    scheduled.get(tick).push(name);
  }

  for (let k = 1; k <= totalTicks; k++) {
    const t = BigInt(k) * TICK;
    const hours = k / TICKS_PER_HOUR;

    // 1. Early supply.
    if (dumpStart !== null && k >= dumpStart) {
      if (insiderStartTick === null) insiderStartTick = k;
      if (scenario === 'slow_bleed') {
        const day = Math.floor((k - dumpStart) / TICKS_PER_DAY) + 1;
        const part = BigInt(Math.min(day, MODEL.bleedDays));
        bleedTarget = (earlySupply * part) / BigInt(MODEL.bleedDays);
        insider.setTarget(bleedTarget);
      }
      const before = insider.sold;
      const shoutedBefore = insider.shouted || 0n;
      insider.step(t);
      if (signalTick === null && (insider.sold > before || (insider.shouted || 0n) > shoutedBefore)) signalTick = k;
      if (exitDoneTick === null && insider.sold * 1000n >= earlySupply * 999n) exitDoneTick = k;
    }

    // 2. Holders that are still working through an exit.
    for (let i = exiting.length - 1; i >= 0; i--) {
      const s = exiting[i];
      s.step(t);
      const left = s.holdings();
      // Loud remainders below the shout minimum cannot leave; quiet ones can.
      if (left === 0n || (s instanceof GreedyLoudSeller && left < token.dust_units)) exiting.splice(i, 1);
    }

    // 3. New buyers.
    const rate = MODEL.buyRatePerHour + MODEL.launchBuyRatePerHour * Math.exp(-hours / MODEL.launchDecayHours);
    const arrivals = poisson(rngBuy, rate / TICKS_PER_HOUR);
    for (let i = 0; i < arrivals; i++) {
      const size = Math.min(MODEL.buyMaxNear, MODEL.buyMedianNear * Math.exp(MODEL.buySigma * normal(rngBuy)));
      const name = `holder-${holderCount++}`;
      token.buy(name, nearToYocto(Math.max(size, 0.001)), 0n, t);
      holders.push(name);
    }

    // 4. Ordinary selling, faster when the price fell over the last hour.
    const ref = price[Math.max(0, k - TICKS_PER_HOUR)];
    const drop = 1 - price[k - 1] / ref;
    let mult = 1;
    if (drop > MODEL.panicThreshold) {
      mult = Math.min(MODEL.panicMax, 1 + MODEL.panicSlope * (drop - MODEL.panicThreshold) / 0.10);
    }
    const sells = poisson(rngSell, (holders.length * mult) / (MODEL.holdDays * TICKS_PER_DAY));
    for (let i = 0; i < sells && holders.length > 0; i++) {
      startExit(holders[Math.floor(rngSell() * holders.length)], t);
    }

    // 5. Scheduled sells (rush after a shout, late-panic shock).
    const due = scheduled.get(k);
    if (due) {
      scheduled.delete(k);
      for (const name of due) if (holders.includes(name)) startExit(name, t);
    }

    // 6. LOUD only: a visible board makes some quiet holders sell during the notice.
    if (rule === 'loud') {
      const visible = token.escrowed * 10000n >= supply * BigInt(MODEL.boardThresholdBps);
      if (visible) {
        if (!boardActive && k - boardLastSeen > MODEL.boardQuietHours * TICKS_PER_HOUR) {
          const noticeTicks = Number(token.notice_ns / TICK);
          const boardPct = Number((token.escrowed * 10000n) / supply) / 100;
          const rush = Math.min(MODEL.rushMax, MODEL.rushPerPct * boardPct) * rushScale;
          for (const name of holders) {
            if (rngRush() < rush) schedule(k + 1 + Math.floor(rngRush() * noticeTicks), name);
          }
        }
        boardActive = true;
        boardLastSeen = k;
      } else {
        boardActive = false;
      }
    }

    // 7. Late panic: an outside shock hits the holders, whatever the rule.
    if (scenario === 'late_panic' && k === 30 * TICKS_PER_DAY) {
      for (const name of holders) {
        if (rngShock() < MODEL.shockShare) {
          schedule(k + 1 + Math.floor(rngShock() * MODEL.shockHours * TICKS_PER_HOUR), name);
        }
      }
    }

    price[k] = token.price();
    exitPx[k] = token.exitPrice(refLot);
    if (k % (6 * TICKS_PER_HOUR) === 0) {
      series.push({
        day: k / TICKS_PER_DAY,
        price: Number(price[k].toPrecision(6)),
        poolNear: Number(yoctoToNear(token.pool_near).toFixed(3)),
        earlySold: Number((Number((insider.sold * 10000n) / earlySupply) / 10000).toFixed(4)),
        holders: holders.length,
      });
    }
  }

  // ---- metrics ----
  // Largest 1-hour fall, measured after the first 12 hours: the launch hours
  // swing widely on a thin pool under every rule.
  const dropFrom = Math.min(DROP_SKIP_HOURS * TICKS_PER_HOUR, Math.floor(totalTicks / 2));
  let maxDrop1h = 0;
  for (let k = dropFrom + 1; k <= totalTicks; k++) {
    let peak = 0;
    for (let j = Math.max(dropFrom, k - TICKS_PER_HOUR); j < k; j++) if (price[j] > peak) peak = price[j];
    const d = 1 - price[k] / peak;
    if (d > maxDrop1h) maxDrop1h = d;
  }

  let leaveUnits = 0n;
  let sellUnits = 0n;
  for (const e of token.events) {
    if (e.event === 'leave') leaveUnits += e.data.filled;
    else if (e.event === 'sell') sellUnits += e.data.tokens_in;
  }
  const allSold = leaveUnits + sellUnits;

  let exitAfterSignal = null;
  let worstExitInHalfHour = null;
  if (signalTick !== null && signalTick + 30 <= totalTicks) {
    const base = exitPx[signalTick - 1];
    exitAfterSignal = exitPx[signalTick + 1] / base;
    let worst = Infinity;
    for (let j = signalTick + 1; j <= signalTick + 30; j++) if (exitPx[j] < worst) worst = exitPx[j];
    worstExitInHalfHour = worst / base;
  }

  return {
    scenario,
    rule,
    variant: rule === 'loud' ? variant : null,
    rushScale,
    seed,
    days,
    metrics: {
      maxDrop1h,
      earlyExitHours: exitDoneTick === null ? null : (exitDoneTick - insiderStartTick) / TICKS_PER_HOUR,
      earlySoldShare: Number((insider.sold * 10000n) / earlySupply) / 10000,
      earlyAnnouncedShare: insider.sold === 0n ? null : rule === 'loud' ? 1 : 0,
      allSellsAnnouncedShare: allSold === 0n ? null : Number((leaveUnits * 10000n) / allSold) / 10000,
      exitAfterSignal,
      worstExitInHalfHour,
      insiderNear: yoctoToNear(insider.near_out),
      finalPrice: price[totalTicks],
      earlySupplyShare: Number((earlySupply * 10000n) / supply) / 10000,
    },
    series,
  };
}

function median(values) {
  const xs = values.filter((x) => x !== null).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

function worst(values, pick) {
  const xs = values.filter((x) => x !== null);
  return xs.length ? pick(...xs) : null;
}

export function runAll({ days = 60, seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9], scenarios = Object.keys(SCENARIOS), log = null } = {}) {
  const rows = [];
  for (const scenario of scenarios) {
    for (const row of RULE_ROWS) {
      const runs = seeds.map((seed) => runScenario({ scenario, rule: row.rule, variant: row.variant || 'standard', days, seed }));
      const m = (key) => runs.map((r) => r.metrics[key]);
      rows.push({
        scenario,
        rule: row.rule,
        variant: row.variant,
        label: row.label,
        median: {
          maxDrop1h: median(m('maxDrop1h')),
          earlyExitHours: median(m('earlyExitHours')),
          earlySoldShare: median(m('earlySoldShare')),
          earlyAnnouncedShare: median(m('earlyAnnouncedShare')),
          allSellsAnnouncedShare: median(m('allSellsAnnouncedShare')),
          exitAfterSignal: median(m('exitAfterSignal')),
          worstExitInHalfHour: median(m('worstExitInHalfHour')),
          insiderNear: median(m('insiderNear')),
          finalPrice: median(m('finalPrice')),
        },
        worstSeed: {
          maxDrop1h: worst(m('maxDrop1h'), Math.max),
          worstExitInHalfHour: worst(m('worstExitInHalfHour'), Math.min),
        },
        earlyExitFinishedRuns: m('earlyExitHours').filter((x) => x !== null).length,
        perSeed: runs.map((r) => ({ seed: r.seed, ...r.metrics })),
        series: runs[0].series,
      });
      if (log) log(`${scenario} / ${row.label}`);
    }
  }
  const sensitivity = [];
  for (const scenario of scenarios.filter((x) => x === 'calm' || x === 'bundle_dump')) {
    for (const rushScale of [0, 1, 3]) {
      const runs = seeds.map((seed) => runScenario({ scenario, rule: 'loud', variant: 'standard', days, seed, rushScale }));
      sensitivity.push({
        scenario,
        rushScale,
        maxDrop1h: median(runs.map((r) => r.metrics.maxDrop1h)),
        worstMaxDrop1h: worst(runs.map((r) => r.metrics.maxDrop1h), Math.max),
        worstExitInHalfHour: median(runs.map((r) => r.metrics.worstExitInHalfHour)),
        finalPrice: median(runs.map((r) => r.metrics.finalPrice)),
      });
      if (log) log(`sensitivity ${scenario} / rush x${rushScale}`);
    }
  }
  return {
    note: 'Model output. Community behaviour is assumed (see model), not measured. Medians over the listed seeds.',
    days,
    seeds,
    tickSeconds: 60,
    base: 'SPEC standard preset: 1,000,000,000 supply, 5% creator, 100 virtual NEAR, 10 min launch window, 60 min exit window, 60 min cap window',
    model: MODEL,
    scenarios: SCENARIOS,
    variants: Object.fromEntries(Object.entries(LOUD_VARIANTS).map(([k, v]) => [k, v.label])),
    rows,
    sensitivity,
  };
}

const pct = (x, d = 1) => (x === null ? 'n/a' : `${(x * 100).toFixed(d)}%`);

export function toMarkdown(result) {
  const out = [];
  out.push('# LOUD: 60-day simulation results');
  out.push('');
  out.push('Generated by `node sim/run.mjs`. Do not edit by hand.');
  out.push('');
  out.push('**This is model output, not market data.** The pool math and the three rule sets are computed by the rule engine');
  out.push('(`web/engine.js`), which is tested against the SPEC and does not model storage cost, asynchronous receipts or');
  out.push('`ft_transfer_call` refunds; how buyers and holders behave is assumed. The assumptions are listed at the end.');
  out.push(`Each cell is the median of ${result.seeds.length} seeded runs of ${result.days} days at 1-minute steps.`);
  out.push('');
  out.push(`Base parameters: ${result.base}.`);
  const early = result.rows[0].perSeed[0].earlySupplyShare;
  out.push(`Early supply: the 5% creator allocation plus a ${MODEL.bundleNear} NEAR first-block bundle, ` +
    `${pct(early)} of supply in total, held in ${MODEL.insiderWallets} wallets.`);
  out.push('');
  out.push('Columns:');
  out.push('');
  out.push('- **max 1h drop**: largest fall of the spot price within any 60 minutes after the first 12 hours (median; worst seed in brackets). The launch hours are left out because a thin pool swings widely there under every rule.');
  out.push('- **early supply exit**: hours from the first sell attempt until 99.9% of early supply is sold.');
  out.push('- **announced (early)**: share of early-supply sales that were public at least one notice period before they executed. ' +
    'Under LOUD this is 100% by construction; under the baselines it is 0% by construction.');
  out.push('- **announced (all)**: share of all units sold into the pool during the run that were announced in advance.');
  out.push('- **holder exit +1 min**: price an ordinary holder gets selling 0.01% of supply one minute after the first public sign ' +
    'of early supply selling (the first shout under LOUD, the first sale under the baselines), relative to the price just before it. ' +
    'This is a quote computed from the pool state at that minute, not a sale made in the run. If the pool cannot pay for the whole lot, it is the price of the part the pool can pay for.');
  out.push('- **worst holder exit in 30 min**: lowest such price during the 30 minutes after that sign (worst seed in brackets). ' +
    'Under LOUD this includes holders who rush out during the notice.');
  out.push('- **early supply proceeds**: NEAR received by the early supply.');
  out.push('');
  for (const scenario of Object.keys(result.scenarios)) {
    const rows = result.rows.filter((r) => r.scenario === scenario);
    if (rows.length === 0) continue;
    out.push(`## ${result.scenarios[scenario]}`);
    out.push('');
    out.push('| rule | max 1h drop | early supply exit | announced (early) | announced (all) | holder exit +1 min | worst holder exit in 30 min | early supply proceeds |');
    out.push('|---|---|---|---|---|---|---|---|');
    for (const r of rows) {
      const m = r.median;
      let exit = 'n/a';
      if (m.earlyExitHours !== null) exit = `${m.earlyExitHours.toFixed(1)} h`;
      else if (m.earlySoldShare > 0) exit = `not finished (${pct(m.earlySoldShare)} sold)`;
      out.push(`| ${r.label} | ${pct(m.maxDrop1h)} (${pct(r.worstSeed.maxDrop1h)}) | ${exit} | ${pct(m.earlyAnnouncedShare, 0)} | ` +
        `${pct(m.allSellsAnnouncedShare)} | ${pct(m.exitAfterSignal)} | ` +
        `${pct(m.worstExitInHalfHour)} (${pct(r.worstSeed.worstExitInHalfHour)}) | ${m.insiderNear.toFixed(1)} NEAR |`);
    }
    out.push('');
  }
  if (result.sensitivity && result.sensitivity.length) {
    out.push('## Sensitivity to the rush assumption (LOUD standard)');
    out.push('');
    out.push('The share of holders who sell during the notice is the assumption LOUD depends on most. ' +
      'The same runs with that share set to zero, as assumed, and three times as large:');
    out.push('');
    out.push('| scenario | rush | max 1h drop | worst holder exit in 30 min |');
    out.push('|---|---|---|---|');
    for (const s of result.sensitivity) {
      out.push(`| ${s.scenario} | x${s.rushScale} | ${pct(s.maxDrop1h)} (${pct(s.worstMaxDrop1h)}) | ${pct(s.worstExitInHalfHour)} |`);
    }
    out.push('');
  }
  out.push('## Which parameters the standard preset uses, and why');
  out.push('');
  out.push(presetParagraph(result));
  out.push('');
  out.push('## What the model does not show');
  out.push('');
  out.push('- Where early supply does not dump, LOUD is worse than no rule in this model. In the calm launch and in the slow bleed the largest 1-hour drop is higher under the standard preset than under the baselines, and in the slow bleed the holder exit price after the first shout is lower. The cause is the assumed rush: a shout by an early buyer makes some holders sell. With the rush set to zero the calm launch falls less than the baselines (sensitivity table).');
  out.push('- In the slow bleed the cap never binds (the insider sells far less than 0.5% per hour), so LOUD does not change the speed. It makes each daily sale public one notice period ahead, and pays for that with the rush above.');
  out.push('- The differences between the LOUD rows in the day-1 dump also come mostly from the rush, which this model ties to the size of the first batch of exits. With the rush set to zero the standard preset falls far less (sensitivity table). Read the ranking of the variants with that in mind.');
  out.push('- LOUD does not protect the price level and does not stop early supply from being paid. The proceeds column shows what the early supply receives under each rule; LOUD changes when and how visibly it sells.');
  out.push('- In the late panic most of the fall comes from ordinary holders, whose quiet tokens no rule slows down. LOUD only keeps the early supply from adding to it in the same hour.');
  out.push('- The LOUD seller follows a fixed greedy routine (batches of exits shouted ahead of time). A better routine could exit somewhat faster, but never faster than the cap.');
  out.push('- The rush (holders who sell during the notice) is assumed, not measured. A larger rush makes the hours after a shout worse; the sensitivity table shows by how much.');
  out.push('- No arbitrage, no outside markets, no fees, no reaction of buyers to a visible board.');
  out.push('');
  out.push('## Model assumptions');
  out.push('');
  out.push('| name | value |');
  out.push('|---|---|');
  for (const [k, v] of Object.entries(result.model)) out.push(`| ${k} | ${v} |`);
  out.push('');
  out.push('Buy arrivals are Poisson with rate `buyRatePerHour + launchBuyRatePerHour * exp(-hours / launchDecayHours)`; ' +
    'sizes are lognormal. Each holder sells everything after an exponential holding time with mean `holdDays`; ' +
    'when the price has fallen more than `panicThreshold` over the last hour the sell rate is multiplied by ' +
    '`1 + panicSlope * (drop - panicThreshold) / 0.10`, at most `panicMax`. Under LOUD, when open exits first exceed ' +
    '`boardThresholdBps` of supply, each quiet holder sells with probability `min(rushMax, rushPerPct * board size in % of supply)` at a random moment within the notice period.');
  out.push('');
  return out.join('\n');
}

function presetParagraph(result) {
  const get = (scenario, rule, variant) => result.rows.find((r) => r.scenario === scenario && r.rule === rule && r.variant === variant);
  const d = (scenario, rule, variant) => {
    const r = get(scenario, rule, variant);
    return r ? r.median : null;
  };
  const naive = d('bundle_dump', 'naive', null);
  const pw = d('bundle_dump', 'per_wallet', null);
  const std = d('bundle_dump', 'loud', 'standard');
  const tight = d('bundle_dump', 'loud', 'tight');
  const loose = d('bundle_dump', 'loud', 'loose');
  const long = d('bundle_dump', 'loud', 'long_notice');
  if (!naive || !pw || !std || !tight || !loose || !long) {
    return 'The standard preset is cap 0.5% of supply per 60 minutes, notice 30 minutes, exit window 60 minutes (SPEC section 3). Run the full set of scenarios to see the comparison.';
  }
  const h = (m) => (m.earlyExitHours === null ? 'more than the run' : `${m.earlyExitHours.toFixed(0)} h`);
  return [
    'The standard preset is **cap 0.5% of supply per 60 minutes, notice 30 minutes, exit window 60 minutes** (SPEC section 3).',
    `In the day-1 bundle dump the baselines let the whole early supply out at once: the largest 1-hour drop is ${pct(naive.maxDrop1h)} with no rule`,
    `and ${pct(pw.maxDrop1h)} with the per-wallet limit, which ${MODEL.insiderWallets} wallets walk straight through,`,
    `and a holder who reacts one minute later sells at ${pct(naive.exitAfterSignal)} of the earlier price.`,
    `With the standard preset the same supply needs ${h(std)} to leave, the largest 1-hour drop is ${pct(std.maxDrop1h)},`,
    `and a holder who reacts one minute after the first shout still gets ${pct(std.exitAfterSignal)}.`,
    `A cap of 2% per hour with a 10-minute notice (loose) empties the early supply in ${h(loose)} with a largest 1-hour drop of ${pct(loose.maxDrop1h)}:`,
    'in this model that is close to no rule at all, and the notice is too short for a person to act on.',
    `A cap of 0.25% per hour with a 60-minute notice (tight) gives a largest 1-hour drop of ${pct(tight.maxDrop1h)}, but the same early supply then needs ${h(tight)}, and honest early buyers wait in the same line.`,
    `A 4-hour notice (long_notice) gives a largest 1-hour drop of ${pct(long.maxDrop1h)} and an exit in ${h(long)};`,
    'it mainly lengthens the time during which holders can leave before the first unit is sold.',
    'In this model the tight and long_notice rows fall less than the standard preset. The preset gives up part of that on purpose, for a shorter wait.',
    'The standard values are the ones written in the SPEC (section 3); the table compares them with tighter and looser variants.',
    'The preset keeps 0.5% per hour because a holder of 5% can still leave within half a day,',
    'and 30 minutes because it is long enough for a person to see the board and act, and short enough that an honest early buyer is not locked in for hours.',
  ].join(' ');
}

function parseArgs(argv) {
  const args = { days: 60, seeds: 9, out: HERE };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--days') args.days = Number(argv[++i]);
    else if (argv[i] === '--seeds') args.seeds = Number(argv[++i]);
    else if (argv[i] === '--out') args.out = argv[++i];
  }
  return args;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const seeds = Array.from({ length: args.seeds }, (_, i) => i + 1);
  const result = runAll({ days: args.days, seeds, log: (line) => console.log(`done: ${line}`) });
  mkdirSync(args.out, { recursive: true });
  writeFileSync(join(args.out, 'results.json'), JSON.stringify(result, null, 1) + '\n');
  writeFileSync(join(args.out, 'RESULTS.md'), toMarkdown(result));
  console.log(`wrote results.json and RESULTS.md (${result.rows.length} rows)`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
