import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LoudToken, NaiveToken, PerWalletToken, LoudError, PRESETS, NEAR, UNIT, SEC, MIN, HOUR, DAY,
  mulDiv, makeRng, runSplitScenario, CONTRACT_ACCOUNT,
} from './engine.js';

const P = PRESETS.standard;
const CREATOR = P.creator;
const SUPPLY = P.total_supply;
const CAP = (SUPPLY * 50n) / 10000n;
const DUST = SUPPLY / 1_000_000n;

function code(c) {
  return (e) => e instanceof LoudError && e.code === c && e.message.startsWith(c);
}

function fresh(overrides = {}) {
  return new LoudToken({ ...P, ...overrides }, 0n);
}

// Token with a creator allocation, one loud buyer and quiet community liquidity.
function seeded() {
  const t = fresh();
  t.buy('early', 5n * NEAR, 0n, 1n * MIN);
  for (let i = 0; i < 10; i++) t.buy(`holder-${i}`, 20n * NEAR, 0n, 10n * MIN);
  return t;
}

function sums(t) {
  let loud = 0n;
  let quiet = 0n;
  for (const v of t.loud.values()) loud += v;
  for (const v of t.quiet.values()) quiet += v;
  return { loud, quiet };
}

function checkInvariants(t) {
  const { loud, quiet } = sums(t);
  assert.equal(t.pool_tokens + loud + quiet + t.escrowed, t.total_supply, 'invariant 1');
  assert.equal(t.loud_outstanding, loud + t.escrowed, 'invariant 2');
  assert.ok(t.contract_near >= t.pool_near, 'invariant 5');
  let open = 0n;
  for (const ex of t.exits.values()) open += ex.remaining;
  assert.equal(open, t.escrowed, 'escrow equals open exits');
}

test('mulDiv rounds down and rejects zero divisor and overflow', () => {
  assert.equal(mulDiv(7n, 3n, 2n), 10n);
  assert.throws(() => mulDiv(1n, 1n, 0n), code('E_MATH'));
  assert.throws(() => mulDiv(1n << 127n, 4n, 1n), code('E_MATH'));
});

test('new: initial state matches SPEC section 4', () => {
  const t = fresh();
  const alloc = (SUPPLY * 5n) / 100n;
  assert.equal(t.getAccount(CREATOR).loud, alloc);
  assert.equal(t.getAccount(CREATOR).quiet, 0n);
  assert.equal(t.pool_tokens, SUPPLY - alloc);
  assert.equal(t.pool_near, 0n);
  assert.equal(t.loud_outstanding, alloc);
  assert.equal(t.bucket_units, 0n);
  const p = t.getParams();
  assert.equal(p.cap_units, CAP);
  assert.equal(p.loud_until, 10n * MIN);
  assert.equal(p.creator_alloc, alloc);
  assert.equal(t.getState(0n).cap_available, 0n);
  assert.equal(t.getState(0n).is_loud_window, true);
  checkInvariants(t);
});

test('new: every parameter bound is checked (E_PARAMS)', () => {
  const bad = [
    { total_supply: 10n ** 24n - 1n }, { total_supply: 10n ** 30n + 1n },
    { creator_alloc_bps: 2001n },
    { virtual_near: 10n ** 23n - 1n }, { virtual_near: 10n ** 30n + 1n },
    { loud_window_ns: 59n * SEC }, { loud_window_ns: 7n * DAY + 1n },
    { notice_ns: 29n * SEC }, { notice_ns: 7n * DAY + 1n },
    { exit_window_ns: 59n * SEC }, { exit_window_ns: 7n * DAY + 1n },
    { cap_bps: 0n }, { cap_bps: 1001n },
    { cap_window_ns: 59n * SEC }, { cap_window_ns: 7n * DAY + 1n },
    { creator: '' },
    // The token account has no key: an allocation minted to it could never move.
    { creator: CONTRACT_ACCOUNT },
    // Metadata is optional in the engine; when given, it is held to the contract's byte limits.
    { name: 'n'.repeat(65) }, { symbol: 'S'.repeat(17) }, { icon: 'i'.repeat(2049) },
    { name: '\u00e9'.repeat(33) }, { name: 7 },
  ];
  for (const o of bad) assert.throws(() => fresh(o), code('E_PARAMS'), JSON.stringify(Object.keys(o)));
  const edge = fresh({
    total_supply: 10n ** 24n, creator_alloc_bps: 0n, virtual_near: 10n ** 23n,
    loud_window_ns: 60n * SEC, notice_ns: 30n * SEC, exit_window_ns: 60n * SEC,
    cap_bps: 1n, cap_window_ns: 60n * SEC,
  });
  assert.equal(edge.loud_outstanding, 0n);
  assert.doesNotThrow(() => new LoudToken(PRESETS.demo, 5n));
  assert.doesNotThrow(() => fresh({ name: 'n'.repeat(64), symbol: 'S'.repeat(16), icon: 'i'.repeat(2048) }));
});

test('buy: pool math, loud inside the window, quiet after it', () => {
  const t = fresh();
  const T = t.pool_tokens;
  const n = 5n * NEAR;
  const expected = (T * n) / (100n * NEAR + n);
  assert.equal(t.quoteBuy(n), expected);
  assert.equal(t.buy('early', n, 0n, 1n * MIN), expected);
  assert.equal(t.getAccount('early').loud, expected);
  assert.equal(t.getAccount('early').quiet, 0n);
  assert.equal(t.pool_near, n);
  // One nanosecond before the window ends is still loud; the boundary is quiet.
  t.buy('edge', NEAR, 0n, 10n * MIN - 1n);
  assert.ok(t.getAccount('edge').loud > 0n);
  const loudBefore = t.loud_outstanding;
  const out = t.buy('late', NEAR, 0n, 10n * MIN);
  assert.deepEqual(t.getAccount('late'), { loud: 0n, quiet: out, exits: [] });
  assert.equal(t.loud_outstanding, loudBefore);
  assert.equal(t.events.at(-1).event, 'buy');
  assert.equal(t.events.at(-1).data.loud, false);
  checkInvariants(t);
});

test('buy: E_DEPOSIT and E_SLIPPAGE leave the state untouched', () => {
  const t = fresh();
  assert.throws(() => t.buy('a', 10n ** 21n - 1n, 0n, 1n), code('E_DEPOSIT'));
  assert.throws(() => t.buy('a', NEAR, t.quoteBuy(NEAR) + 1n, 1n), code('E_SLIPPAGE'));
  assert.equal(t.pool_near, 0n);
  assert.equal(t.events.length, 0);
  assert.equal(t.buy('a', 10n ** 21n, 0n, 1n), t.getAccount('a').loud);
});

test('sell: quiet only; loud holders get E_NO_QUIET with both balances in the message', () => {
  const t = seeded();
  assert.throws(() => t.sell('early', 1n, 0n, 11n * MIN), (e) => {
    return code('E_NO_QUIET')(e) && /loud/.test(e.message) && /shout/.test(e.message) &&
      e.message.includes(String(t.getAccount('early').loud));
  });
  assert.throws(() => t.sell(CREATOR, DUST, 0n, 11n * MIN), code('E_NO_QUIET'));
  const q = t.getAccount('holder-0').quiet;
  const quote = t.quoteSell(q);
  const R = t.virtual_near + t.pool_near;
  assert.equal(quote, (R * q) / (t.pool_tokens + q));
  assert.throws(() => t.sell('holder-0', q, quote + 1n, 11n * MIN), code('E_SLIPPAGE'));
  assert.throws(() => t.sell('holder-0', q + 1n, 0n, 11n * MIN), code('E_NO_QUIET'));
  const nearBefore = t.pool_near;
  assert.equal(t.sell('holder-0', q, quote, 11n * MIN), quote);
  assert.equal(t.pool_near, nearBefore - quote);
  assert.equal(t.getAccount('holder-0').quiet, 0n);
  checkInvariants(t);
});

test('pool buyers stay clean: a buy after the window can be sold at once (SPEC 8.3)', () => {
  const t = seeded();
  const out = t.buy('newcomer', 3n * NEAR, 0n, 2n * HOUR);
  assert.equal(t.getAccount('newcomer').loud, 0n);
  assert.ok(t.sell('newcomer', out, 0n, 2n * HOUR) > 0n);
});

test('shout: escrow, timestamps, E_NO_LOUD, E_DUST, E_TOO_MANY', () => {
  const t = seeded();
  const held = t.getAccount(CREATOR).loud;
  assert.throws(() => t.shout(CREATOR, 0n, 11n * MIN), code('E_NO_LOUD'));
  assert.throws(() => t.shout(CREATOR, held + 1n, 11n * MIN), code('E_NO_LOUD'));
  assert.throws(() => t.shout('holder-0', DUST, 11n * MIN), code('E_NO_LOUD'));
  assert.throws(() => t.shout(CREATOR, DUST - 1n, 11n * MIN), code('E_DUST'));
  const id = t.shout(CREATOR, DUST, 11n * MIN);
  assert.equal(id, 1n);
  const ex = t.getAccount(CREATOR).exits[0];
  assert.deepEqual(ex, {
    id: 1n, owner: CREATOR, amount: DUST, remaining: DUST,
    shouted_at: 11n * MIN, ready_at: 41n * MIN, expires_at: 101n * MIN,
  });
  assert.equal(t.escrowed, DUST);
  assert.equal(t.getAccount(CREATOR).loud, held - DUST);
  assert.equal(t.loud_outstanding, held + t.getAccount('early').loud);
  for (let i = 0; i < 7; i++) t.shout(CREATOR, DUST, 11n * MIN);
  assert.throws(() => t.shout(CREATOR, DUST, 11n * MIN), code('E_TOO_MANY'));
  assert.equal(t.getExits(0, 100).length, 8);
  assert.equal(t.getExits(6, 100).length, 2);
  assert.equal(t.getState(11n * MIN).open_exits, 8);
  assert.equal(t.shout_count, 8n);
  checkInvariants(t);
});

test('shout: a whole loud balance below the dust floor can be shouted; a part of it cannot', () => {
  const t = seeded();
  t.transferLoud(CREATOR, 'small', DUST - 1n, 11n * MIN);
  assert.throws(() => t.shout('small', DUST - 2n, 11n * MIN), code('E_DUST'));
  assert.equal(t.getAccount('small').loud, DUST - 1n);
  const id = t.shout('small', DUST - 1n, 11n * MIN);
  assert.equal(t.getAccount('small').loud, 0n);
  assert.equal(t.getAccount('small').exits[0].remaining, DUST - 1n);
  const quote = t.quoteSell(DUST - 1n);
  assert.ok(quote > 0n);
  assert.equal(t.leave('small', id, quote, 41n * MIN), DUST - 1n);
  assert.equal(t.last_near_out, quote);
  assert.equal(t.getAccount('small').exits.length, 0);
  checkInvariants(t);
  // One unit is worth less than one yoctoNEAR here: the shout is accepted and
  // leave fails with E_AMOUNT. The unit comes back through hush once the exit
  // has expired (shouted at minute 41, ready at 71, expires at 131).
  t.transferLoud(CREATOR, 'tiny', 1n, 41n * MIN);
  const tinyId = t.shout('tiny', 1n, 41n * MIN);
  assert.equal(t.quoteSell(1n), 0n);
  assert.throws(() => t.leave('tiny', tinyId, 0n, 71n * MIN), code('E_AMOUNT'));
  assert.equal(t.escrowed, 1n);
  assert.throws(() => t.hush('tiny', tinyId, 71n * MIN), code('E_NOTICE_BINDING'));
  assert.equal(t.hush('tiny', tinyId, 131n * MIN + 1n), 1n);
  assert.equal(t.getAccount('tiny').loud, 1n);
  checkInvariants(t);
});

test('shout: below the dust floor the account must have no other open exit', () => {
  const t = seeded();
  t.transferLoud(CREATOR, 'small', 2n * DUST - 1n, 11n * MIN);
  // One exit is open. What is left is the whole balance and below the floor.
  const first = t.shout('small', DUST, 11n * MIN);
  assert.equal(t.getAccount('small').loud, DUST - 1n);
  assert.throws(() => t.shout('small', DUST - 1n, 11n * MIN), (e) => code('E_DUST')(e) &&
    e.message.includes(`${DUST} units`) && e.message.includes(`${DUST - 1n} units`) && /you have 1 open/.test(e.message));
  assert.equal(t.getAccount('small').loud, DUST - 1n);
  assert.equal(t.getAccount('small').exits.length, 1);
  // With no open exit the message counts zero and a part is still refused.
  t.transferLoud(CREATOR, 'other', DUST - 1n, 11n * MIN);
  assert.throws(() => t.shout('other', DUST - 2n, 11n * MIN), (e) => code('E_DUST')(e) && /you have 0 open/.test(e.message));
  // The open exit sells out and closes. Now the remainder is accepted.
  assert.equal(t.leave('small', first, 0n, 41n * MIN), DUST);
  assert.equal(t.getAccount('small').exits.length, 0);
  const second = t.shout('small', DUST - 1n, 41n * MIN);
  assert.equal(t.getAccount('small').loud, 0n);
  assert.deepEqual(t.getAccount('small').exits.map((ex) => [ex.id, ex.remaining]), [[second, DUST - 1n]]);
  // Eight open exits and a remainder below the floor: E_DUST comes first.
  for (let i = 0; i < 8; i++) t.shout(CREATOR, DUST, 41n * MIN);
  const all = t.getAccount(CREATOR).loud;
  t.transferLoud(CREATOR, 'other', all - 1n, 41n * MIN);
  assert.throws(() => t.shout(CREATOR, 1n, 41n * MIN), code('E_DUST'));
  checkInvariants(t);
});

test('error messages give times since launch', () => {
  const launch = 1_700_000_000n * SEC;
  const t = new LoudToken(P, launch);
  t.buy('early', 5n * NEAR, 0n, launch + 1n * MIN);
  for (let i = 0; i < 10; i++) t.buy(`holder-${i}`, 20n * NEAR, 0n, launch + 10n * MIN);
  // Shouted at minute 11: ready at 41, expires at 101.
  const a = t.shout(CREATOR, 3n * CAP, launch + 11n * MIN);
  assert.throws(() => t.hush(CREATOR, a, launch + 50n * MIN), (e) => code('E_NOTICE_BINDING')(e) &&
    e.message === 'E_NOTICE_BINDING: a shout cannot be taken back; this exit expires 101 min after launch and can be closed after that');
  // Part of a second is rounded up to the next whole second.
  const b = t.shout(CREATOR, DUST, launch + 11n * MIN + 30n * SEC + 1n);
  assert.throws(() => t.hush(CREATOR, b, launch + 50n * MIN), (e) => code('E_NOTICE_BINDING')(e) &&
    /expires 101 min 31 s after launch/.test(e.message) && !/\d{7,}/.test(e.message));
  // The first leave empties the bucket. Room is back one nanosecond later,
  // and the message rounds that up to the next whole second.
  const now = launch + 41n * MIN;
  assert.ok(t.leave(CREATOR, a, 0n, now) > 0n);
  assert.throws(() => t.leave(CREATOR, a, 0n, now), (e) => code('E_CAP')(e) &&
    e.message === 'E_CAP: the global cap has no room right now; room returns 41 min 1 s after launch');
  assert.equal(t.getState(now).next_room_ts, now + 1n);
  assert.ok(t.leave(CREATOR, a, 0n, now + 1n * SEC) > 0n);
});

test('leave: min_near_out is scaled to the part filled; a full fill keeps the plain limit', () => {
  const t = seeded();
  const amount = 3n * CAP;
  const id = t.shout(CREATOR, amount, 10n * MIN);
  const ready = 40n * MIN;
  const avail = t.getState(ready).cap_available;
  assert.ok(avail > 0n && avail < amount);
  const quoteWhole = t.quoteSell(amount);
  const quotePart = t.quoteSell(avail);
  assert.ok(quoteWhole > quotePart, 'an absolute limit could not pass');
  // The highest limit this fill meets: floor(near_out * remaining / fill).
  const edge = (quotePart * amount) / avail;
  assert.ok(edge >= quoteWhole);
  const before = snapshot(t);
  assert.throws(() => t.leave(CREATOR, id, edge + 1n, ready), code('E_SLIPPAGE'));
  assert.deepEqual(snapshot(t), before);
  // The quote for the whole exit is a fair limit for a part of it.
  assert.equal(t.leave(CREATOR, id, quoteWhole, ready), avail);
  assert.equal(t.last_near_out, quotePart);
  // The next fill is measured against what was left before it.
  const left = amount - avail;
  const t2 = ready + 6n * MIN;
  const avail2 = t.getState(t2).cap_available;
  assert.ok(avail2 > 0n && avail2 < left);
  const quote2 = t.quoteSell(avail2);
  const edge2 = (quote2 * left) / avail2;
  assert.throws(() => t.leave(CREATOR, id, edge2 + 1n, t2), code('E_SLIPPAGE'));
  assert.equal(t.leave(CREATOR, id, edge2, t2), avail2);
  assert.equal(t.getAccount(CREATOR).exits[0].remaining, left - avail2);
  checkInvariants(t);
  // Full fill: exactly the old rule, near_out >= min_near_out.
  const small = t.shout('early', DUST * 10n, t2);
  const t3 = t2 + 60n * MIN;
  const quoteSmall = t.quoteSell(DUST * 10n);
  assert.throws(() => t.leave('early', small, quoteSmall + 1n, t3), code('E_SLIPPAGE'));
  assert.equal(t.leave('early', small, quoteSmall, t3), DUST * 10n);
  assert.equal(t.last_near_out, quoteSmall);
  checkInvariants(t);
});

test('leave: notice, expiry, ownership, cap fill, tokens become quiet inventory', () => {
  const t = seeded();
  const amount = 3n * CAP;
  const id = t.shout(CREATOR, amount, 10n * MIN);
  const ready = 40n * MIN;
  assert.throws(() => t.leave('early', id, 0n, ready), code('E_NOT_OWNER'));
  assert.throws(() => t.leave(CREATOR, 99n, 0n, ready), code('E_NO_EXIT'));
  assert.throws(() => t.leave(CREATOR, id, 0n, ready - 1n), (e) => code('E_NOTICE')(e) && /1 seconds/.test(e.message));
  // The bucket started empty at launch and refilled for 40 minutes.
  const avail = t.getState(ready).cap_available;
  assert.equal(avail, (CAP * 40n) / 60n);
  const quote = t.quoteSell(avail);
  // A partial fill: the limit is for the whole exit and is scaled to the fill.
  const limit = (quote * amount) / avail;
  assert.throws(() => t.leave(CREATOR, id, limit + 1n, ready), code('E_SLIPPAGE'));
  const poolBefore = t.pool_tokens;
  const nearBefore = t.pool_near;
  assert.equal(t.leave(CREATOR, id, limit, ready), avail);
  assert.equal(t.last_near_out, quote);
  assert.equal(t.pool_tokens, poolBefore + avail);
  assert.equal(t.pool_near, nearBefore - quote);
  assert.equal(t.getAccount(CREATOR).exits[0].remaining, amount - avail);
  assert.equal(t.getAccount(CREATOR).quiet, 0n);
  assert.throws(() => t.leave(CREATOR, id, 0n, ready), code('E_CAP'));
  const st = t.getState(ready);
  assert.equal(st.cap_available, 0n);
  assert.ok(st.next_room_ts > ready);
  assert.equal(st.total_left, avail);
  // Thirty minutes later half a cap has refilled.
  assert.equal(t.leave(CREATOR, id, 0n, ready + 30n * MIN), CAP / 2n);
  // The last allowed moment is expires_at itself.
  assert.ok(t.leave(CREATOR, id, 0n, 100n * MIN) > 0n);
  assert.throws(() => t.leave(CREATOR, id, 0n, 100n * MIN + 1n), code('E_EXPIRED'));
  checkInvariants(t);
  // A buyer of the tokens that went through the door receives quiet tokens.
  const out = t.buy('after', NEAR, 0n, 101n * MIN);
  assert.equal(t.getAccount('after').quiet, out);
});

test('leave: a full fill removes the exit', () => {
  const t = seeded();
  const id = t.shout('early', DUST * 10n, 10n * MIN);
  assert.equal(t.leave('early', id, 0n, 40n * MIN), DUST * 10n);
  assert.equal(t.getAccount('early').exits.length, 0);
  assert.equal(t.getState(40n * MIN).open_exits, 0);
  assert.throws(() => t.leave('early', id, 0n, 40n * MIN), code('E_NO_EXIT'));
  assert.equal(t.events.at(-1).event, 'leave');
  assert.equal(t.events.at(-1).data.remaining, 0n);
});

test('leave: E_POOL_EMPTY when the pool holds no NEAR, state untouched', () => {
  const t = fresh();
  const id = t.shout(CREATOR, CAP, 0n);
  const before = { bucket: t.bucket_units, ts: t.bucket_ts, escrowed: t.escrowed };
  assert.throws(() => t.leave(CREATOR, id, 0n, 30n * MIN), code('E_POOL_EMPTY'));
  assert.deepEqual({ bucket: t.bucket_units, ts: t.bucket_ts, escrowed: t.escrowed }, before);
  checkInvariants(t);
});

test('hush: a shout is binding until the exit has expired, then anyone can close it', () => {
  const t = seeded();
  const held = t.getAccount(CREATOR).loud;
  // Shouted at minute 10: ready at 40, expires at 100.
  const a = t.shout(CREATOR, CAP, 10n * MIN);
  const b = t.shout(CREATOR, CAP, 10n * MIN);
  const before = snapshot(t);
  // Nobody takes a shout back, the owner included: not right after it, not
  // during the notice, not inside the exit window, not at expires_at itself.
  for (const now of [10n * MIN, 20n * MIN, 40n * MIN, 100n * MIN]) {
    for (const who of [CREATOR, 'holder-0']) {
      assert.throws(() => t.hush(who, a, now), code('E_NOTICE_BINDING'), `${who} at ${now}`);
    }
  }
  assert.deepEqual(snapshot(t), before);
  assert.equal(t.escrowed, 2n * CAP);

  t.leave(CREATOR, b, 0n, 40n * MIN);
  const remaining = t.getAccount(CREATOR).exits.find((e) => e.id === b).remaining;
  assert.ok(remaining > 0n && remaining < CAP);
  // A partly sold exit is just as binding.
  assert.throws(() => t.hush(CREATOR, b, 100n * MIN), code('E_NOTICE_BINDING'));

  // One nanosecond after expires_at the owner closes one, a stranger the other.
  assert.equal(t.hush(CREATOR, a, 100n * MIN + 1n), CAP);
  assert.equal(t.getAccount(CREATOR).loud, held - CAP);
  assert.equal(t.hush('holder-0', b, 100n * MIN + 1n), remaining);
  // The tokens go back to the owner, not to the caller, and stay loud.
  assert.equal(t.getAccount(CREATOR).loud, held - (CAP - remaining));
  assert.equal(t.getAccount(CREATOR).quiet, 0n);
  assert.equal(t.getAccount('holder-0').loud, 0n);
  assert.equal(t.escrowed, 0n);
  assert.throws(() => t.hush(CREATOR, b, 101n * MIN), code('E_NO_EXIT'));
  checkInvariants(t);
});

test('statistics counters saturate instead of stopping a shout or a leave', () => {
  const t = seeded();
  const U128_MAX = (1n << 128n) - 1n;
  const U64_MAX = (1n << 64n) - 1n;
  t.total_shouted = U128_MAX;
  t.shout_count = U64_MAX;
  t.total_left = U128_MAX;
  t.leave_count = U64_MAX;
  const id = t.shout(CREATOR, CAP, 10n * MIN);
  assert.ok(t.leave(CREATOR, id, 0n, 40n * MIN) > 0n);
  const s = t.getState(40n * MIN);
  assert.equal(s.total_shouted, U128_MAX);
  assert.equal(s.shout_count, U64_MAX);
  assert.equal(s.total_left, U128_MAX);
  assert.equal(s.leave_count, U64_MAX);
});

test('transfer: quiet first, then loud, and the tag follows the tokens (SPEC 8.2)', () => {
  const t = seeded();
  // Give the early buyer some quiet tokens as well.
  const q = t.buy('early', NEAR, 0n, 11n * MIN);
  const l = t.getAccount('early').loud;
  assert.throws(() => t.transfer('early', 'early', 1n, 11n * MIN), code('E_SELF'));
  assert.throws(() => t.transfer('early', 'bob', q + l + 1n, 11n * MIN), code('E_BALANCE'));
  assert.deepEqual(t.transfer('early', 'bob', q - 5n, 11n * MIN), { quiet_amount: q - 5n, loud_amount: 0n });
  assert.deepEqual(t.transfer('early', 'bob', 15n, 11n * MIN), { quiet_amount: 5n, loud_amount: 10n });
  assert.deepEqual(t.getAccount('bob'), { loud: 10n, quiet: q, exits: [] });
  assert.equal(t.events.at(-1).event, 'tag_move');
  assert.deepEqual(t.events.at(-1).data, { from: 'early', to: 'bob', loud_amount: 10n });
  assert.equal(t.balanceOf('early'), l - 10n);
  // Splitting loud tokens: every receiver is loud and cannot use sell.
  const part = t.getAccount(CREATOR).loud / 4n;
  for (const w of ['w1', 'w2', 'w3']) {
    t.transferLoud(CREATOR, w, part, 12n * MIN);
    assert.equal(t.getAccount(w).loud, part);
    assert.throws(() => t.sell(w, part, 0n, 12n * MIN), code('E_NO_QUIET'));
  }
  assert.throws(() => t.transferLoud('holder-0', 'w1', 1n, 12n * MIN), code('E_NO_LOUD'));
  assert.throws(() => t.transferLoud(CREATOR, CREATOR, 1n, 12n * MIN), code('E_SELF'));
  // The token account cannot receive tokens through any transfer method.
  assert.throws(() => t.transfer('bob', CONTRACT_ACCOUNT, 1n, 12n * MIN), code('E_RECEIVER'));
  assert.throws(() => t.transferLoud('w1', CONTRACT_ACCOUNT, 1n, 12n * MIN), code('E_RECEIVER'));
  assert.throws(() => t.transferCall('bob', CONTRACT_ACCOUNT, 1n, 12n * MIN), code('E_RECEIVER'));
  // ft_transfer_call takes quiet only.
  assert.throws(() => t.transferCall('w1', 'dex', 1n, 12n * MIN), code('E_QUIET_DOOR'));
  assert.throws(() => t.transferCall('bob', 'dex', q + 1n, 12n * MIN), code('E_QUIET_DOOR'));
  assert.equal(t.transferCall('bob', 'dex', q, 12n * MIN), q);
  assert.equal(t.getAccount('bob').loud, 10n);
  checkInvariants(t);
});

test('cap bucket: starts empty, refills linearly, never exceeds cap_units', () => {
  const empty = fresh();
  assert.equal(empty.getState(0n).cap_available, 0n);
  assert.equal(empty.getState(15n * MIN).cap_available, CAP / 4n);
  assert.equal(empty.getState(60n * MIN).cap_available, CAP);
  assert.equal(empty.getState(10n * DAY).cap_available, CAP);
  const t = seeded();
  // A long quiet period does not bank more than one cap.
  const id = t.shout(CREATOR, 4n * CAP, 5n * DAY);
  const ready = 5n * DAY + 30n * MIN;
  assert.equal(t.leave(CREATOR, id, 0n, ready), CAP);
  assert.equal(t.leave(CREATOR, id, 0n, ready + 6n * MIN), CAP / 10n);
});

test('clock: time cannot move backwards', () => {
  const t = seeded();
  assert.throws(() => t.buy('x', NEAR, 0n, 1n), code('E_CLOCK'));
});

test('invariants 1-5 hold under a randomized sequence', () => {
  const rng = makeRng(20261113);
  const t = fresh();
  const accounts = Array.from({ length: 40 }, (_, i) => `acct-${i}`);
  accounts.push(CREATOR);
  const pick = () => accounts[Math.floor(rng() * accounts.length)];
  const frac = (v) => (v * BigInt(1 + Math.floor(rng() * 1000))) / 1000n;
  let now = 0n;
  let lastLoudOutstanding = null;
  const leaves = [];
  const counts = { ok: 0, failed: 0, hushed: 0 };
  const seen = new Set();
  for (let i = 0; i < 6000; i++) {
    // Dense activity in the launch window, then jumps of up to 3 minutes.
    now += i < 300 ? BigInt(Math.floor(rng() * 4e9)) : BigInt(Math.floor(rng() * 180e9));
    const a = pick();
    const acc = t.getAccount(a);
    const op = Math.floor(rng() * 8);
    const availBefore = t.getState(now).cap_available;
    const leftBefore = t.total_left;
    try {
      if (op === 0) t.buy(a, BigInt(Math.floor(rng() * 3e6)) * 10n ** 18n, 0n, now);
      else if (op === 1) t.sell(a, frac(acc.quiet), 0n, now);
      else if (op === 2) t.shout(a, frac(acc.loud), now);
      else if (op === 3 || op === 4) {
        const all = t.getExits(0, 100);
        const own = acc.exits.length && rng() < 0.9 ? acc.exits : all;
        if (own.length) {
          const ex = own[Math.floor(rng() * own.length)];
          t.leave(rng() < 0.9 ? ex.owner : a, ex.id, 0n, now);
        }
      } else if (op === 5) {
        const all = t.getExits(0, 100);
        if (all.length) {
          const ex = all[Math.floor(rng() * all.length)];
          t.hush(a, ex.id, now);
          // Reached only when the hush went through: the exit had expired.
          assert.ok(now > ex.expires_at, 'an exit was hushed before it expired');
          counts.hushed++;
        }
      } else if (op === 6) t.transfer(a, pick(), frac(acc.loud + acc.quiet), now);
      else t.transferLoud(a, pick(), frac(acc.loud), now);
      counts.ok++;
    } catch (e) {
      assert.ok(e instanceof LoudError, `unexpected error ${e}`);
      seen.add(e.code);
      counts.failed++;
    }
    checkInvariants(t);
    if (t.total_left > leftBefore) leaves.push({ t: now, fill: t.total_left - leftBefore, availBefore });
    // Invariant 3: no growth of loud supply once the launch window is over.
    if (now >= t.loud_until) {
      if (lastLoudOutstanding !== null) assert.ok(t.loud_outstanding <= lastLoudOutstanding, 'invariant 3');
      lastLoudOutstanding = t.loud_outstanding;
    }
  }
  assert.ok(counts.ok > 1500, `only ${counts.ok} calls succeeded`);
  assert.ok(leaves.length > 100, `only ${leaves.length} leaves`);
  for (const c of ['E_NOTICE', 'E_EXPIRED', 'E_NOT_OWNER', 'E_NOTICE_BINDING']) assert.ok(seen.has(c), `${c} never hit`);
  assert.ok(counts.hushed > 20, `only ${counts.hushed} expired exits were hushed`);
  const capBound = leaves.filter((l) => l.fill === l.availBefore).length;
  assert.ok(capBound > 20, `the cap limited only ${capBound} leaves`);
  if (process.env.LOUD_TEST_DEBUG) console.log(counts, [...seen], leaves.length, capBound);
  // Invariant 4 for every interval that starts and ends at a leave.
  for (let i = 0; i < leaves.length; i++) {
    let sum = 0n;
    for (let j = i; j < leaves.length; j++) {
      sum += leaves[j].fill;
      const bound = leaves[i].availBefore + (CAP * (leaves[j].t - leaves[i].t)) / (60n * MIN);
      assert.ok(sum <= bound, `invariant 4 broken between leaves ${i} and ${j}`);
    }
  }
});

// Split test (SPEC 8.1 and 8.4)

const SPLIT = { insiderShareBps: 500, horizonNs: 12n * HOUR, stepNs: 60n * SEC };

function soldAt(series, seconds) {
  const p = series.find((x) => x.t === seconds);
  assert.ok(p, `no point at t=${seconds}`);
  return BigInt(p.insiderSoldUnits);
}

test('split, loud: 1 wallet and 100 wallets sell at the same speed', () => {
  const one = runSplitScenario({ ...SPLIT, rule: 'loud', wallets: 1 });
  const hundred = runSplitScenario({ ...SPLIT, rule: 'loud', wallets: 100 });
  assert.equal(one.length, hundred.length);
  for (let i = 0; i < one.length; i++) {
    const a = BigInt(one[i].insiderSoldUnits);
    const b = BigInt(hundred[i].insiderSoldUnits);
    const diff = a > b ? a - b : b - a;
    assert.ok(diff <= 100n, `sold differs by ${diff} units at t=${one[i].t}`);
    assert.ok(Math.abs(one[i].price - hundred[i].price) <= one[i].price * 1e-9);
  }
  // The insider shouts at minute 11 (first step after the launch window), so
  // nothing can be sold before minute 41.
  const ready = 41 * 60;
  assert.equal(soldAt(hundred, ready - 60), 0n);
  // First cap window after notice: at most what the bucket held when the
  // notice ended plus one window of refill (invariant 4). The bucket started
  // empty at launch and refilled for 41 minutes.
  const bucketAtReady = (CAP * 41n) / 60n;
  for (const s of [one, hundred]) {
    const first = soldAt(s, ready + 3600) - soldAt(s, ready - 60);
    assert.ok(first <= bucketAtReady + CAP, 'first cap window exceeds invariant 4');
    assert.ok(first >= bucketAtReady + CAP - CAP / 50n, 'greedy seller left room unused');
  }
  // Every later hour releases exactly one cap, for 1 and for 100 wallets.
  for (const s of [one, hundred]) {
    for (let h = 2; h <= 6; h++) {
      const perHour = soldAt(s, ready + h * 3600) - soldAt(s, ready + (h - 1) * 3600);
      assert.ok(perHour <= CAP);
      assert.ok(perHour >= CAP - CAP / 50n, `hour ${h} sold ${perHour}`);
    }
  }
  // 5% of supply at 0.5% per hour: not finished after 9 hours, finished by 11.
  assert.ok(one.find((x) => x.t === ready + 9 * 3600).insiderSold < 1);
  assert.ok(one.at(-1).insiderSold > 0.999999);
  assert.ok(hundred.at(-1).insiderSold > 0.999999);
});

test('split, loud: the hourly rate is the same for 1, 7, 20 and 100 wallets', () => {
  const runs = [1, 7, 20, 100].map((w) => runSplitScenario({
    rule: 'loud', wallets: w, insiderShareBps: 500, horizonNs: 4n * HOUR, stepNs: 5n * MIN,
  }));
  for (const s of runs.slice(1)) {
    for (let i = 0; i < s.length; i++) {
      const a = BigInt(runs[0][i].insiderSoldUnits);
      const b = BigInt(s[i].insiderSoldUnits);
      assert.ok((a > b ? a - b : b - a) <= 100n);
    }
  }
});

test('split, naive: everything is sold in the first step for 1 and for 100 wallets', () => {
  for (const wallets of [1, 100]) {
    const s = runSplitScenario({ ...SPLIT, rule: 'naive', wallets, horizonNs: 1n * HOUR });
    assert.equal(s[0].insiderSold, 0);
    assert.ok(s[1].insiderSold > 0.999999, `wallets=${wallets} sold ${s[1].insiderSold}`);
    assert.ok(s[1].price < s[0].price);
  }
});

test('split, per_wallet: 100 wallets sell 100 times faster than 1', () => {
  // Half of supply, so that neither run is limited by its holdings in step 1.
  const opts = { rule: 'per_wallet', insiderShareBps: 5000, horizonNs: 2n * HOUR, stepNs: 60n * SEC };
  const one = runSplitScenario({ ...opts, wallets: 1 });
  const hundred = runSplitScenario({ ...opts, wallets: 100 });
  const perTx = (SUPPLY * 50n) / 10000n;
  assert.equal(BigInt(one[1].insiderSoldUnits), perTx);
  assert.equal(BigInt(hundred[1].insiderSoldUnits), 100n * perTx);
  assert.equal(BigInt(one[10].insiderSoldUnits), 10n * perTx);
  assert.ok(hundred[1].insiderSold > 0.999);
  assert.ok(one[1].insiderSold < 0.011);
  // With the 5% of the other tests, 100 wallets are as fast as no rule at all.
  const small = runSplitScenario({ ...SPLIT, rule: 'per_wallet', wallets: 100, horizonNs: 1n * HOUR });
  const naive = runSplitScenario({ ...SPLIT, rule: 'naive', wallets: 100, horizonNs: 1n * HOUR });
  assert.equal(small[1].insiderSoldUnits, naive[1].insiderSoldUnits);
  const single = runSplitScenario({ ...SPLIT, rule: 'per_wallet', wallets: 1, horizonNs: 1n * HOUR });
  assert.equal(BigInt(single[1].insiderSoldUnits), perTx);
  assert.ok(single[10].insiderSold > 0.999999);
});

test('split: an ordinary holder gets a better exit under loud than under the baselines', () => {
  const at = (rule) => runSplitScenario({ ...SPLIT, rule, wallets: 100, horizonNs: 1n * HOUR });
  const loud = at('loud');
  const naive = at('naive');
  const perWallet = at('per_wallet');
  assert.equal(loud[0].quietHolderExitPrice, naive[0].quietHolderExitPrice);
  // Two minutes after the insider starts: under loud the shout is public and
  // nothing has been sold yet; under the baselines the dump is already done.
  assert.equal(loud[2].quietHolderExitPrice, loud[0].quietHolderExitPrice);
  assert.ok(loud[2].announced > 0);
  assert.ok(naive[2].quietHolderExitPrice < loud[2].quietHolderExitPrice);
  assert.ok(perWallet[2].quietHolderExitPrice < loud[2].quietHolderExitPrice);
});

test('baselines: per-wallet limit and cooldown, naive has neither', () => {
  const params = { ...P, creator_alloc_bps: 2000n };
  const pw = new PerWalletToken(params, 0n);
  const nv = new NaiveToken(params, 0n);
  for (const t of [pw, nv]) for (let i = 0; i < 10; i++) t.buy(`h${i}`, 30n * NEAR, 0n, 1n);
  assert.equal(pw.pool_tokens, nv.pool_tokens);
  const max = (SUPPLY * 50n) / 10000n;
  assert.throws(() => pw.sell(CREATOR, max + 1n, 0n, 2n), code('E_MAX_SELL'));
  pw.sell(CREATOR, max, 0n, 2n);
  assert.throws(() => pw.sell(CREATOR, 1n, 0n, 2n + 59n * SEC), code('E_COOLDOWN'));
  pw.sell(CREATOR, max, 0n, 2n + 60n * SEC);
  // A second wallet has its own limit and its own cooldown.
  pw.transfer(CREATOR, 'second', max, 2n + 60n * SEC);
  pw.sell('second', max, 0n, 2n + 60n * SEC);
  assert.throws(() => pw.sell('h0', pw.balanceOf('h0') + 1n, 0n, 3n * MIN), code('E_BALANCE'));
  const all = nv.balanceOf(CREATOR);
  assert.ok(nv.sell(CREATOR, all, 0n, 2n) > 0n);
  assert.equal(nv.balanceOf(CREATOR), 0n);
  assert.ok(nv.contract_near >= nv.pool_near && pw.contract_near >= pw.pool_near);
});

test('units are consistent', () => {
  assert.equal(UNIT, 10n ** 18n);
  assert.equal(HOUR, 3600n * SEC);
  assert.equal(PRESETS.demo.virtual_near, 5n * NEAR);
});

// Everything a failed call must not change.
function snapshot(t) {
  return {
    loud: [...t.loud], quiet: [...t.quiet], exits: [...t.exits.keys()],
    pool_tokens: t.pool_tokens, pool_near: t.pool_near, contract_near: t.contract_near,
    loud_outstanding: t.loud_outstanding, escrowed: t.escrowed,
    bucket_units: t.bucket_units, bucket_ts: t.bucket_ts, last_now: t.last_now,
    next_exit_id: t.next_exit_id, events: t.events.length,
  };
}

test('inputs outside u128/u64 fail with E_PARAMS and leave the state untouched', () => {
  const t = seeded();
  const now = 20n * MIN;
  const before = snapshot(t);
  const bad = code('E_PARAMS');
  for (const x of [-1n, -5n * UNIT, -1, 1n << 128n, 1e24, 0.5, '-3', null]) {
    assert.throws(() => t.transferLoud(CREATOR, 'b', x, now), bad, `transferLoud ${x}`);
    assert.throws(() => t.transfer(CREATOR, 'b', x, now), bad, `transfer ${x}`);
    assert.throws(() => t.transferCall('holder-0', 'b', x, now), bad, `transferCall ${x}`);
    assert.throws(() => t.sell('holder-0', x, 0n, now), bad, `sell ${x}`);
    assert.throws(() => t.shout(CREATOR, x, now), bad, `shout ${x}`);
    assert.throws(() => t.buy('b', x, 0n, now), bad, `buy ${x}`);
  }
  assert.throws(() => t.sell('holder-0', 1n, -(10n ** 30n), now), bad);
  assert.throws(() => t.buy('b', NEAR, -1n, now), bad);
  // Timestamps and exit ids are u64.
  assert.throws(() => t.buy('b', NEAR, 0n, 1n << 64n), bad);
  assert.throws(() => t.buy('b', NEAR, 0n, -1n), bad);
  assert.throws(() => t.getState(1n << 64n), bad);
  assert.throws(() => t.hush(CREATOR, 1n << 64n, now), bad);
  assert.throws(() => t.leave(CREATOR, -1n, 0n, now), bad);
  assert.throws(() => new LoudToken(P, (1n << 64n) + 5n), bad);
  assert.throws(() => new NaiveToken(P, -1n), bad);
  assert.throws(() => new LoudToken(P, (1n << 64n) - 1n), bad, 'loud window overflows the clock');
  assert.deepEqual(snapshot(t), before);
  checkInvariants(t);
});

test('u128 and u64 edges follow the contract: E_MATH on reserve overflow, saturating exit times', () => {
  const t = seeded();
  const before = snapshot(t);
  const U128_MAX = (1n << 128n) - 1n;
  assert.throws(() => t.buy('x', U128_MAX, 0n, 20n * MIN), code('E_MATH'));
  assert.throws(() => t.quoteBuy(U128_MAX), code('E_MATH'));
  assert.throws(() => t.quoteSell(U128_MAX), code('E_MATH'));
  assert.deepEqual(snapshot(t), before);

  const U64_MAX = (1n << 64n) - 1n;
  const id = t.shout(CREATOR, CAP, U64_MAX - 1n);
  const ex = t.getAccount(CREATOR).exits.find((e) => e.id === id);
  assert.equal(ex.ready_at, U64_MAX);
  assert.equal(ex.expires_at, U64_MAX);
  checkInvariants(t);
});

test('events: loud events carry the contract field names, each after its ft_transfer', () => {
  const t = seeded();
  const last2 = () => t.events.slice(-2).map((e) => [e.event, e.data]);
  const out = t.buy('late', NEAR, 0n, 10n * MIN);
  assert.deepEqual(last2(), [
    ['ft_transfer', { old_owner_id: CONTRACT_ACCOUNT, new_owner_id: 'late', amount: out }],
    ['buy', { account: 'late', near_in: NEAR, tokens_out: out, loud: false }],
  ]);
  const nearOut = t.sell('late', out, 0n, 10n * MIN);
  assert.deepEqual(last2(), [
    ['ft_transfer', { old_owner_id: 'late', new_owner_id: CONTRACT_ACCOUNT, amount: out }],
    ['sell', { account: 'late', tokens_in: out, near_out: nearOut }],
  ]);
  const id = t.shout(CREATOR, CAP, 10n * MIN);
  assert.deepEqual(last2(), [
    ['ft_transfer', { old_owner_id: CREATOR, new_owner_id: CONTRACT_ACCOUNT, amount: CAP, memo: 'shout' }],
    ['shout', { id, account: CREATOR, amount: CAP, ready_at: 40n * MIN, expires_at: 100n * MIN }],
  ]);
  // Hushed by someone else after expiry: `account` is the owner, `by` the caller.
  t.hush('holder-0', id, 100n * MIN + 1n);
  assert.deepEqual(last2(), [
    ['ft_transfer', { old_owner_id: CONTRACT_ACCOUNT, new_owner_id: CREATOR, amount: CAP, memo: 'hush' }],
    ['hush', { id, account: CREATOR, amount: CAP, by: 'holder-0' }],
  ]);
  t.transferLoud(CREATOR, 'otc', DUST, 101n * MIN);
  assert.deepEqual(last2(), [
    ['ft_transfer', { old_owner_id: CREATOR, new_owner_id: 'otc', amount: DUST, memo: 'transfer_loud' }],
    ['tag_move', { from: CREATOR, to: 'otc', loud_amount: DUST }],
  ]);
  const nv = new NaiveToken(P, 0n);
  const got = nv.buy('a', NEAR, 0n, 1n);
  const back = nv.sell('a', got, 0n, 1n);
  assert.deepEqual(nv.events.at(-1).data, { account: 'a', tokens_in: got, near_out: back });
});

test('balanceOf: the token account holds pool and escrow, balances add up and match the ft_transfer events', () => {
  const t = fresh();
  // The engine emits no ft_mint; start the ledger from the two mints of `new`.
  const ledger = new Map([[CREATOR, t.creator_alloc], [CONTRACT_ACCOUNT, SUPPLY - t.creator_alloc]]);
  let seen = 0;
  const check = (step) => {
    for (const e of t.events.slice(seen)) {
      if (e.event !== 'ft_transfer') continue;
      const { old_owner_id: from, new_owner_id: to, amount } = e.data;
      ledger.set(from, (ledger.get(from) || 0n) - amount);
      ledger.set(to, (ledger.get(to) || 0n) + amount);
    }
    seen = t.events.length;
    let sum = 0n;
    for (const [account, amount] of ledger) {
      assert.equal(t.balanceOf(account), amount, `${step}: balance of ${account}`);
      sum += amount;
    }
    assert.equal(sum, t.total_supply, `${step}: balances add up to the supply`);
    checkInvariants(t);
  };
  check('new');
  assert.equal(t.balanceOf(CONTRACT_ACCOUNT), t.pool_tokens);

  t.buy('early', 1000n * NEAR, 0n, 1n * MIN);
  check('loud buy');
  const got = t.buy('late', 10n * NEAR, 0n, 11n * MIN);
  check('quiet buy');
  const id = t.shout(CREATOR, 4n * CAP, 11n * MIN);
  assert.equal(t.balanceOf(CONTRACT_ACCOUNT), t.pool_tokens + 4n * CAP);
  check('shout');
  t.transfer('late', 'friend', got / 4n, 11n * MIN);
  t.transferLoud(CREATOR, 'friend', DUST, 11n * MIN);
  // A transfer to the token account is refused, quiet or loud, so its balance
  // stays the pool inventory plus the escrow.
  assert.throws(() => t.transfer('late', CONTRACT_ACCOUNT, got / 4n, 11n * MIN), code('E_RECEIVER'));
  assert.throws(() => t.transferLoud(CREATOR, CONTRACT_ACCOUNT, DUST, 11n * MIN), code('E_RECEIVER'));
  assert.throws(() => t.transferCall('late', CONTRACT_ACCOUNT, got / 4n, 11n * MIN), code('E_RECEIVER'));
  assert.equal(t.balanceOf(CONTRACT_ACCOUNT), t.pool_tokens + t.escrowed);
  assert.equal(t.getAccount('late').quiet, got - got / 4n);
  check('transfers');
  const filled = t.leave(CREATOR, id, 0n, 41n * MIN);
  assert.ok(filled > 0n && filled < 4n * CAP, 'partial leave');
  check('partial leave');
  // Shouted at minute 11: ready at 41, expires at 101. The rest comes back after that.
  assert.throws(() => t.hush(CREATOR, id, 101n * MIN), code('E_NOTICE_BINDING'));
  t.hush(CREATOR, id, 101n * MIN + 1n);
  assert.equal(t.escrowed, 0n);
  check('hush');
  t.sell('late', t.getAccount('late').quiet, 0n, 101n * MIN + 1n);
  assert.equal(t.balanceOf('late'), 0n);
  check('sell');
});

test('exitPrice: quotes only what the pool can pay for, 0 when nothing can be sold', () => {
  // Payable lot: the price of sell(amount).
  const t = seeded();
  const lot = SUPPLY / 10000n;
  assert.ok(lot <= t.maxSellable());
  assert.equal(t.exitPrice(lot), Number((t.quoteSell(lot) * 10n ** 12n) / lot) / 1e18);
  assert.equal(t.exitPrice(0n), 0);

  // Empty pool: the formula quote is positive, the sale throws, the price is 0.
  const empty = fresh();
  assert.ok(empty.quoteSell(lot) > 0n);
  assert.equal(empty.exitPrice(lot), 0);
  const nv = new NaiveToken(P, 0n);
  assert.throws(() => nv.sell(CREATOR, lot, 0n, 1n), code('E_POOL_EMPTY'));
  assert.equal(nv.exitPrice(lot), 0);

  // Thin pool: only part of the lot is payable. The quote is the price of
  // that part, and selling that part pays exactly the quoted NEAR.
  // The unbacked creator allocation takes about half of the pool's NEAR first.
  const thin = fresh({ cap_bps: 1000n, cap_window_ns: MIN, notice_ns: 30n * SEC });
  const have = thin.buy('late', NEAR / 100n, 0n, 10n * MIN);
  const id = thin.shout(CREATOR, have / 2n, 10n * MIN);
  assert.equal(thin.leave(CREATOR, id, 0n, 10n * MIN + 30n * SEC), have / 2n);
  assert.equal(thin.getAccount('late').quiet, have);
  const part = thin.maxSellable();
  assert.ok(part > 0n && part < have);
  assert.ok(thin.quoteSell(have) > thin.pool_near, 'the whole lot is not payable');
  assert.throws(() => thin.sell('late', have, 0n, 11n * MIN), code('E_POOL_EMPTY'));
  const quote = thin.quoteSell(part);
  assert.ok(quote <= thin.pool_near);
  const px = thin.exitPrice(have);
  assert.equal(px, Number((quote * 10n ** 12n) / part) / 1e18);
  // Pool NEAR over the whole lot would be a price no sale can get.
  assert.ok(px > Number((thin.pool_near * 10n ** 12n) / have) / 1e18);
  assert.ok(px > 0 && px < thin.price());
  assert.equal(thin.sell('late', part, 0n, 11n * MIN), quote);
});
