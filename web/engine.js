// LOUD rule engine. Dependency-free ES module, BigInt arithmetic, explicit clock.
//
// LoudToken mirrors SPEC.md sections 3-7 method for method. Field names follow
// the SPEC (snake_case); every amount and timestamp is a BigInt.
//   buy(account, nearYocto, minOut, now)            -> tokens out
//   sell(account, amount, minNearOut, now)          -> yoctoNEAR out (quiet only)
//   shout(account, amount, now)                     -> exit id
//   leave(account, exitId, minNearOut, now)         -> units filled (near in last_near_out);
//       minNearOut is for everything left in the exit and is scaled to the part filled
//   hush(account, exitId, now)                      -> units returned to loud;
//       only after the exit has expired, by anyone (a shout is binding)
//   transfer(account, receiver, amount, now)        -> { quiet_amount, loud_amount }
//   transferLoud(account, receiver, amount, now)    -> amount
//   transferCall(account, receiver, amount, now)    -> amount (quiet only)
//   getParams(), getState(now), getAccount(id), getExits(from, limit),
//   quoteBuy(near), quoteSell(amount)
// A failed call throws LoudError (an Error with .code; the message starts with
// the code) and leaves the state untouched, like a reverted transaction.
// Amounts must fit u128 and timestamps and exit ids u64, as on chain; anything
// else (negative, too large, an unsafe Number) fails with E_PARAMS.
// Every successful call appends to .events: the `loud` events with the
// contract's field names, and the NEP-141 ft_transfer entries the contract logs
// before them (CONTRACT_ACCOUNT stands for the token account).
// balanceOf mirrors ft_balance_of: loud + quiet, and for CONTRACT_ACCOUNT also
// the pool inventory and the escrow, so all balances add up to total_supply.
// Differences from the contract, sandbox only: hush returns the units returned
// (the contract method returns nothing), and the constructor emits no ft_mint.
// Storage registration is not modelled: there is no storage_deposit, no
// storage fee and no E_UNREGISTERED, any account can receive tokens, the whole
// NEAR passed to buy reaches the pool, and the buy event has no storage_paid.
// name, symbol and icon are optional here and only checked for their size.
//
// NaiveToken and PerWalletToken are the comparison baselines of SPEC 8.4 with
// the same pool math. runSplitScenario drives a greedy insider under each rule.

export const NEAR = 10n ** 24n;
export const UNIT = 10n ** 18n;
export const SEC = 1_000_000_000n;
export const MIN = 60n * SEC;
export const HOUR = 60n * MIN;
export const DAY = 24n * HOUR;

const U128_MAX = (1n << 128n) - 1n;
const U64_MAX = (1n << 64n) - 1n;
// Stands for the token contract's own account in ft_transfer events.
export const CONTRACT_ACCOUNT = 'loud.contract';
const MIN_DEPOSIT = 10n ** 21n;
const MAX_EXITS_PER_ACCOUNT = 8;
// Metadata size limits of `new`, in UTF-8 bytes.
const MAX_META_BYTES = Object.freeze({ name: 64, symbol: 16, icon: 2048 });

export const PRESETS = Object.freeze({
  standard: Object.freeze({
    total_supply: 1_000_000_000n * UNIT,
    creator: 'creator.testnet',
    creator_alloc_bps: 500n,
    virtual_near: 100n * NEAR,
    loud_window_ns: 10n * MIN,
    notice_ns: 30n * MIN,
    exit_window_ns: 60n * MIN,
    cap_bps: 50n,
    cap_window_ns: 60n * MIN,
  }),
  demo: Object.freeze({
    total_supply: 1_000_000_000n * UNIT,
    creator: 'creator.testnet',
    creator_alloc_bps: 500n,
    virtual_near: 5n * NEAR,
    loud_window_ns: 2n * MIN,
    notice_ns: 1n * MIN,
    exit_window_ns: 10n * MIN,
    cap_bps: 50n,
    cap_window_ns: 10n * MIN,
  }),
});

export class LoudError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'LoudError';
    this.code = code;
  }
}

function fail(code, detail) {
  throw new LoudError(code, detail);
}

function toBig(v, name) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^[0-9]+$/.test(v)) return BigInt(v);
  fail('E_PARAMS', `${name || 'value'} is not an unsigned integer`);
}

// Amounts: the contract takes them as U128 JSON, which cannot carry a negative
// or larger value.
function big(v, name) {
  const r = toBig(v, name);
  if (r < 0n || r > U128_MAX) fail('E_PARAMS', `${name || 'value'} is not a u128`);
  return r;
}

// Timestamps and exit ids (u64 on chain).
function big64(v, name) {
  const r = toBig(v, name);
  if (r < 0n || r > U64_MAX) fail('E_PARAMS', `${name || 'value'} is not a u64`);
  return r;
}

function min(a, b) {
  return a < b ? a : b;
}

// floor(a*b/c); throws on c == 0 or a result above u128.
export function mulDiv(a, b, c) {
  if (c === 0n) fail('E_MATH', 'division by zero');
  const r = (a * b) / c;
  if (r > U128_MAX) fail('E_MATH', 'result does not fit u128');
  return r;
}

// Deterministic PRNG (mulberry32). Returns a function giving floats in [0, 1).
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function checkAccount(account) {
  if (typeof account !== 'string' || account.length === 0) fail('E_ACCOUNT', 'invalid account id');
}

// Constant product pool with a virtual NEAR reserve (SPEC section 5).
class Pool {
  constructor(totalSupply, virtualNear, poolTokens, nowNs) {
    this.total_supply = totalSupply;
    this.virtual_near = virtualNear;
    this.pool_tokens = poolTokens;
    this.pool_near = 0n;
    // NEAR actually received minus NEAR actually paid out (invariant 5).
    this.contract_near = 0n;
    this.launch_ts = nowNs;
    this.last_now = nowNs;
    this.events = [];
  }

  _clock(now) {
    const t = big64(now, 'now');
    if (t < this.last_now) fail('E_CLOCK', 'time moved backwards');
    return t;
  }

  _emit(event, t, data) {
    this.events.push({ event, t, data });
  }

  quoteBuy(near) {
    const n = big(near, 'near');
    const reserve = this.virtual_near + this.pool_near;
    if (reserve + n > U128_MAX) fail('E_MATH', 'deposit is too large for the pool math');
    return mulDiv(this.pool_tokens, n, reserve + n);
  }

  quoteSell(amount) {
    const x = big(amount, 'amount');
    if (this.pool_tokens + x > U128_MAX) fail('E_MATH', 'amount is too large for the pool math');
    return mulDiv(this.virtual_near + this.pool_near, x, this.pool_tokens + x);
  }

  // Largest amount that can be sold before the pool runs out of real NEAR.
  maxSellable() {
    return (this.pool_near * this.pool_tokens) / this.virtual_near;
  }

  // Spot price in whole NEAR per whole token, as a Number (display only).
  price() {
    return Number(((this.virtual_near + this.pool_near) * 10n ** 12n) / this.pool_tokens) / 1e18;
  }

  // Whole NEAR per whole token of the sale a holder of `amount` units can
  // actually make now: sell(fill) with fill = min(amount, maxSellable()), at
  // the formula price. When the pool can pay for all of `amount` this is the
  // price of sell(amount). In a thin pool it is the price of the payable part
  // only; the rest of the lot cannot be sold at any price until NEAR comes
  // in, and is not in this number. Returns 0 when no part can be sold.
  // A quote from the pool state, for display and the simulation.
  exitPrice(amount) {
    const x = big(amount, 'amount');
    if (x === 0n) return 0;
    const fill = min(x, this.maxSellable());
    if (fill === 0n) return 0;
    const out = this.quoteSell(fill);
    if (out === 0n) return 0;
    return Number((out * 10n ** 12n) / fill) / 1e18;
  }

  _poolBuy(n, minOut) {
    if (n < MIN_DEPOSIT) fail('E_DEPOSIT', 'attach at least 0.001 NEAR');
    const out = this.quoteBuy(n);
    if (out === 0n || out >= this.pool_tokens) fail('E_AMOUNT', 'buy size out of range');
    if (out < minOut) fail('E_SLIPPAGE', `tokens out ${out} below minimum ${minOut}`);
    return out;
  }

  // minNearOut is the limit for `whole` units and is scaled to the x units sold
  // now: the sale needs nearOut * whole >= minNearOut * x. A plain sell has
  // whole === x, which is nearOut >= minNearOut.
  _poolSell(x, minNearOut, whole = x) {
    const nearOut = this.quoteSell(x);
    if (nearOut === 0n) fail('E_AMOUNT', 'this sale is too small to pay anything');
    if (nearOut > this.pool_near) fail('E_POOL_EMPTY', 'pool does not hold enough NEAR');
    if (nearOut * whole < minNearOut * x) {
      if (x === whole) fail('E_SLIPPAGE', `near out ${nearOut} below minimum ${minNearOut}`);
      fail('E_SLIPPAGE', `near out ${nearOut} for ${x} of ${whole} units is below minimum ${minNearOut} scaled to the part filled`);
    }
    return nearOut;
  }

  _applyBuy(n, out) {
    this.pool_near += n;
    this.contract_near += n;
    this.pool_tokens -= out;
  }

  _applySell(x, nearOut) {
    this.pool_near -= nearOut;
    this.contract_near -= nearOut;
    this.pool_tokens += x;
  }
}

function checkParams(p) {
  const inRange = (v, lo, hi, name) => {
    if (v < lo || v > hi) fail('E_PARAMS', `${name} out of bounds`);
  };
  inRange(p.total_supply, 10n ** 24n, 10n ** 30n, 'total_supply');
  if (typeof p.creator !== 'string' || p.creator.length === 0) fail('E_PARAMS', 'creator is not a valid account');
  // The token account has no key, so an allocation minted to it could never move.
  if (p.creator === CONTRACT_ACCOUNT) fail('E_PARAMS', 'creator cannot be the token account');
  inRange(p.creator_alloc_bps, 0n, 2000n, 'creator_alloc_bps');
  inRange(p.virtual_near, 10n ** 23n, 10n ** 30n, 'virtual_near');
  inRange(p.loud_window_ns, 60n * SEC, 7n * DAY, 'loud_window_ns');
  inRange(p.notice_ns, 30n * SEC, 7n * DAY, 'notice_ns');
  inRange(p.exit_window_ns, 60n * SEC, 7n * DAY, 'exit_window_ns');
  inRange(p.cap_bps, 1n, 1000n, 'cap_bps');
  inRange(p.cap_window_ns, 60n * SEC, 7n * DAY, 'cap_window_ns');
}

function readParams(params) {
  if (!params || typeof params !== 'object') fail('E_PARAMS', 'missing params');
  const names = ['total_supply', 'creator_alloc_bps', 'virtual_near', 'loud_window_ns',
    'notice_ns', 'exit_window_ns', 'cap_bps', 'cap_window_ns'];
  const p = { creator: params.creator };
  for (const name of names) p[name] = big(params[name], name);
  for (const [name, limit] of Object.entries(MAX_META_BYTES)) {
    const v = params[name];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string' || new TextEncoder().encode(v).length > limit) {
      fail('E_PARAMS', `${name} must be a string of at most ${limit} bytes`);
    }
  }
  return p;
}

export class LoudToken extends Pool {
  constructor(params, nowNs) {
    const p = readParams(params);
    checkParams(p);
    const now = big64(nowNs, 'now');
    if (now + p.loud_window_ns > U64_MAX) fail('E_PARAMS', 'loud window overflows the clock');
    const creatorAlloc = (p.total_supply * p.creator_alloc_bps) / 10000n;
    super(p.total_supply, p.virtual_near, p.total_supply - creatorAlloc, now);
    this.creator = p.creator;
    this.creator_alloc_bps = p.creator_alloc_bps;
    this.creator_alloc = creatorAlloc;
    this.loud_window_ns = p.loud_window_ns;
    this.notice_ns = p.notice_ns;
    this.exit_window_ns = p.exit_window_ns;
    this.cap_bps = p.cap_bps;
    this.cap_window_ns = p.cap_window_ns;
    this.loud_until = now + p.loud_window_ns;
    this.cap_units = (p.total_supply * p.cap_bps) / 10000n;
    this.dust_units = p.total_supply / 1_000_000n;

    this.loud = new Map();
    this.quiet = new Map();
    this.loud_outstanding = creatorAlloc;
    this.escrowed = 0n;
    this.bucket_units = 0n;
    this.bucket_ts = now;
    this.exits = new Map();
    this.next_exit_id = 1n;
    this.total_shouted = 0n;
    this.total_left = 0n;
    this.shout_count = 0n;
    this.leave_count = 0n;
    this.last_near_out = 0n;

    if (creatorAlloc > 0n) this.loud.set(this.creator, creatorAlloc);
  }

  // Internals

  _loudOf(a) {
    return this.loud.get(a) || 0n;
  }

  _quietOf(a) {
    return this.quiet.get(a) || 0n;
  }

  _set(map, account, value) {
    if (value === 0n) map.delete(account);
    else map.set(account, value);
  }

  _refill(now) {
    if (now > this.bucket_ts) {
      const add = mulDiv(this.cap_units, now - this.bucket_ts, this.cap_window_ns);
      if (add > 0n) {
        this.bucket_units = min(this.cap_units, this.bucket_units + add);
        this.bucket_ts = now;
      }
    }
  }

  _available(now) {
    if (now <= this.bucket_ts) return this.bucket_units;
    const add = mulDiv(this.cap_units, now - this.bucket_ts, this.cap_window_ns);
    return min(this.cap_units, this.bucket_units + add);
  }

  // Runs one state-changing call. `body` must finish every check before it
  // mutates anything; the bucket and clock are restored if it throws.
  _tx(account, now, body) {
    checkAccount(account);
    const t = this._clock(now);
    const saved = [this.bucket_units, this.bucket_ts, this.last_now];
    this._refill(t);
    this.last_now = t;
    try {
      return body(t);
    } catch (e) {
      [this.bucket_units, this.bucket_ts, this.last_now] = saved;
      throw e;
    }
  }

  _exit(exitId) {
    const id = big64(exitId, 'exit_id');
    const ex = this.exits.get(id);
    if (!ex) fail('E_NO_EXIT', `no open exit with id ${id}`);
    return ex;
  }

  // A timestamp as time since launch for error messages: "101 min" or
  // "101 min 30 s". Part of a second counts as a whole one, so the call
  // works once the engine clock has passed the printed time.
  _sinceLaunch(ts) {
    const s = (ts - this.launch_ts + SEC - 1n) / SEC;
    const rest = s % 60n;
    return rest === 0n ? `${s / 60n} min` : `${s / 60n} min ${rest} s`;
  }

  _openExitsOf(account) {
    const out = [];
    for (const ex of this.exits.values()) if (ex.owner === account) out.push(ex);
    return out;
  }

  // Trading

  buy(account, nearYocto, minOut, now) {
    return this._tx(account, now, (t) => {
      const n = big(nearYocto, 'near');
      const out = this._poolBuy(n, big(minOut, 'min_tokens_out'));
      this._applyBuy(n, out);
      const isLoud = t < this.loud_until;
      if (isLoud) {
        this.loud.set(account, this._loudOf(account) + out);
        this.loud_outstanding += out;
      } else {
        this.quiet.set(account, this._quietOf(account) + out);
      }
      this._emit('ft_transfer', t, { old_owner_id: CONTRACT_ACCOUNT, new_owner_id: account, amount: out });
      this._emit('buy', t, { account, near_in: n, tokens_out: out, loud: isLoud });
      return out;
    });
  }

  sell(account, amount, minNearOut, now) {
    return this._tx(account, now, (t) => {
      const x = big(amount, 'amount');
      if (x === 0n) fail('E_AMOUNT', 'amount must be positive');
      const quiet = this._quietOf(account);
      if (x > quiet) {
        fail('E_NO_QUIET', `sell uses quiet tokens only: you hold ${quiet} quiet and ` +
          `${this._loudOf(account)} loud units; loud tokens must use shout then leave`);
      }
      const nearOut = this._poolSell(x, big(minNearOut, 'min_near_out'));
      this._applySell(x, nearOut);
      this._set(this.quiet, account, quiet - x);
      this.last_near_out = nearOut;
      this._emit('ft_transfer', t, { old_owner_id: account, new_owner_id: CONTRACT_ACCOUNT, amount: x });
      this._emit('sell', t, { account, tokens_in: x, near_out: nearOut });
      return nearOut;
    });
  }

  // The door for loud tokens

  shout(account, amount, now) {
    return this._tx(account, now, (t) => {
      const x = big(amount, 'amount');
      const held = this._loudOf(account);
      if (x === 0n || x > held) fail('E_NO_LOUD', `you hold ${held} loud units`);
      // Below the dust floor only a whole balance may be shouted, and only by
      // an account with no other open exit.
      const open = this._openExitsOf(account).length;
      if (x < this.dust_units && (x !== held || open > 0)) {
        fail('E_DUST', `shout at least ${this.dust_units} units. A smaller shout must be your whole loud balance ` +
          `(${held} units) with no other open exit (you have ${open} open)`);
      }
      if (open >= MAX_EXITS_PER_ACCOUNT) {
        fail('E_TOO_MANY', `at most ${MAX_EXITS_PER_ACCOUNT} open exits per account`);
      }
      const id = this.next_exit_id;
      this.next_exit_id += 1n;
      // The contract saturates both at the end of the u64 clock.
      const readyAt = min(t + this.notice_ns, U64_MAX);
      const ex = {
        id,
        owner: account,
        amount: x,
        remaining: x,
        shouted_at: t,
        ready_at: readyAt,
        expires_at: min(readyAt + this.exit_window_ns, U64_MAX),
      };
      this._set(this.loud, account, held - x);
      this.escrowed += x;
      this.exits.set(id, ex);
      // Display counters saturate on chain, so they can never stop a call.
      this.total_shouted = min(this.total_shouted + x, U128_MAX);
      this.shout_count = min(this.shout_count + 1n, U64_MAX);
      this._emit('ft_transfer', t, {
        old_owner_id: account, new_owner_id: CONTRACT_ACCOUNT, amount: x, memo: 'shout',
      });
      this._emit('shout', t, {
        id, account, amount: x, ready_at: ex.ready_at, expires_at: ex.expires_at,
      });
      return id;
    });
  }

  leave(account, exitId, minNearOut, now) {
    return this._tx(account, now, (t) => {
      const ex = this._exit(exitId);
      if (ex.owner !== account) fail('E_NOT_OWNER', 'only the exit owner can leave');
      if (t < ex.ready_at) {
        const left = (ex.ready_at - t + SEC - 1n) / SEC;
        fail('E_NOTICE', `${left} seconds of notice left`);
      }
      if (t > ex.expires_at) fail('E_EXPIRED', 'exit window is over; hush and shout again');
      let fill = min(ex.remaining, this.bucket_units);
      if (fill === 0n) {
        fail('E_CAP', `the global cap has no room right now; room returns ${this._sinceLaunch(this._nextRoomTs(t))} after launch`);
      }
      // Same as the contract: if the pool cannot pay for all of it, fill what it can pay for.
      if (this.quoteSell(fill) > this.pool_near) {
        fill = min(fill, this.maxSellable());
        if (fill === 0n) fail('E_POOL_EMPTY', 'the pool cannot pay for any part of this exit');
      }
      // The limit is for everything left in the exit; a partial fill is held to
      // the same price (remaining is read before this fill).
      const nearOut = this._poolSell(fill, big(minNearOut, 'min_near_out'), ex.remaining);
      this.bucket_units -= fill;
      this.escrowed -= fill;
      this.loud_outstanding -= fill;
      ex.remaining -= fill;
      this._applySell(fill, nearOut);
      if (ex.remaining === 0n) this.exits.delete(ex.id);
      this.total_left = min(this.total_left + fill, U128_MAX);
      this.leave_count = min(this.leave_count + 1n, U64_MAX);
      this.last_near_out = nearOut;
      this._emit('leave', t, {
        id: ex.id, account, filled: fill, remaining: ex.remaining, near_out: nearOut,
      });
      return fill;
    });
  }

  hush(account, exitId, now) {
    return this._tx(account, now, (t) => {
      const ex = this._exit(exitId);
      // A shout is binding: nobody takes it back before the exit has expired,
      // the owner included. After that anyone may close it.
      if (t <= ex.expires_at) {
        fail('E_NOTICE_BINDING', 'a shout cannot be taken back; this exit expires ' +
          `${this._sinceLaunch(ex.expires_at)} after launch and can be closed after that`);
      }
      const back = ex.remaining;
      this.loud.set(ex.owner, this._loudOf(ex.owner) + back);
      this.escrowed -= back;
      this.exits.delete(ex.id);
      this._emit('ft_transfer', t, {
        old_owner_id: CONTRACT_ACCOUNT, new_owner_id: ex.owner, amount: back, memo: 'hush',
      });
      this._emit('hush', t, { id: ex.id, account: ex.owner, amount: back, by: account });
      return back;
    });
  }

  // NEP-141

  transfer(account, receiver, amount, now) {
    return this._tx(account, now, (t) => {
      checkAccount(receiver);
      if (receiver === account) fail('E_SELF', 'sender and receiver are the same');
      if (receiver === CONTRACT_ACCOUNT) fail('E_RECEIVER', 'the token account cannot receive tokens');
      const x = big(amount, 'amount');
      if (x === 0n) fail('E_AMOUNT', 'amount must be positive');
      const quiet = this._quietOf(account);
      const loud = this._loudOf(account);
      if (x > quiet + loud) fail('E_BALANCE', `balance is ${quiet + loud} units`);
      const quietPart = min(x, quiet);
      const loudPart = x - quietPart;
      if (quietPart > 0n) {
        this._set(this.quiet, account, quiet - quietPart);
        this.quiet.set(receiver, this._quietOf(receiver) + quietPart);
      }
      if (loudPart > 0n) {
        this._set(this.loud, account, loud - loudPart);
        this.loud.set(receiver, this._loudOf(receiver) + loudPart);
      }
      this._emit('ft_transfer', t, { old_owner_id: account, new_owner_id: receiver, amount: x });
      if (loudPart > 0n) this._emit('tag_move', t, { from: account, to: receiver, loud_amount: loudPart });
      return { quiet_amount: quietPart, loud_amount: loudPart };
    });
  }

  transferLoud(account, receiver, amount, now) {
    return this._tx(account, now, (t) => {
      checkAccount(receiver);
      if (receiver === account) fail('E_SELF', 'sender and receiver are the same');
      if (receiver === CONTRACT_ACCOUNT) fail('E_RECEIVER', 'the token account cannot receive tokens');
      const x = big(amount, 'amount');
      const loud = this._loudOf(account);
      if (x === 0n || x > loud) fail('E_NO_LOUD', `you hold ${loud} loud units`);
      this._set(this.loud, account, loud - x);
      this.loud.set(receiver, this._loudOf(receiver) + x);
      this._emit('ft_transfer', t, {
        old_owner_id: account, new_owner_id: receiver, amount: x, memo: 'transfer_loud',
      });
      this._emit('tag_move', t, { from: account, to: receiver, loud_amount: x });
      return x;
    });
  }

  // ft_transfer_call with a receiver that keeps everything. Quiet only.
  transferCall(account, receiver, amount, now) {
    return this._tx(account, now, (t) => {
      checkAccount(receiver);
      if (receiver === account) fail('E_SELF', 'sender and receiver are the same');
      if (receiver === CONTRACT_ACCOUNT) fail('E_RECEIVER', 'the token account cannot receive tokens');
      const x = big(amount, 'amount');
      if (x === 0n) fail('E_AMOUNT', 'amount must be positive');
      const quiet = this._quietOf(account);
      if (x > quiet) {
        fail('E_QUIET_DOOR', 'loud tokens cannot go into other contracts through ft_transfer_call');
      }
      this._set(this.quiet, account, quiet - x);
      this.quiet.set(receiver, this._quietOf(receiver) + x);
      this._emit('ft_transfer', t, { old_owner_id: account, new_owner_id: receiver, amount: x });
      return x;
    });
  }

  // ft_balance_of. The token account also owns the pool inventory and the
  // escrow (the ft_transfer events of buy, sell, shout and hush say so).
  balanceOf(account) {
    const own = this._loudOf(account) + this._quietOf(account);
    return account === CONTRACT_ACCOUNT ? own + this.pool_tokens + this.escrowed : own;
  }

  // Views

  _nextRoomTs(now) {
    if (this._available(now) > 0n) return now;
    // First timestamp at which the refill adds at least one unit.
    const wait = (this.cap_window_ns + this.cap_units - 1n) / this.cap_units;
    return this.bucket_ts + wait;
  }

  getParams() {
    return {
      total_supply: this.total_supply,
      creator: this.creator,
      creator_alloc_bps: this.creator_alloc_bps,
      virtual_near: this.virtual_near,
      loud_window_ns: this.loud_window_ns,
      notice_ns: this.notice_ns,
      exit_window_ns: this.exit_window_ns,
      cap_bps: this.cap_bps,
      cap_window_ns: this.cap_window_ns,
      launch_ts: this.launch_ts,
      loud_until: this.loud_until,
      cap_units: this.cap_units,
      creator_alloc: this.creator_alloc,
    };
  }

  getState(now) {
    const t = big64(now, 'now');
    return {
      pool_tokens: this.pool_tokens,
      pool_near: this.pool_near,
      loud_outstanding: this.loud_outstanding,
      escrowed: this.escrowed,
      cap_available: this._available(t),
      cap_units: this.cap_units,
      next_room_ts: this._nextRoomTs(t),
      open_exits: this.exits.size,
      total_shouted: this.total_shouted,
      total_left: this.total_left,
      shout_count: this.shout_count,
      leave_count: this.leave_count,
      now: t,
      is_loud_window: t < this.loud_until,
    };
  }

  getAccount(account) {
    return {
      loud: this._loudOf(account),
      quiet: this._quietOf(account),
      exits: this._openExitsOf(account).map((ex) => ({ ...ex })),
    };
  }

  getExits(fromIndex = 0, limit = 100) {
    const from = Number(fromIndex);
    const lim = Math.min(Number(limit), 100);
    return [...this.exits.values()].slice(from, from + lim).map((ex) => ({ ...ex }));
  }
}

// Baseline 1: the same pool, no rule at all.
export class NaiveToken extends Pool {
  constructor(params, nowNs) {
    const p = readParams(params);
    checkParams(p);
    const now = big64(nowNs, 'now');
    const creatorAlloc = (p.total_supply * p.creator_alloc_bps) / 10000n;
    super(p.total_supply, p.virtual_near, p.total_supply - creatorAlloc, now);
    this.creator = p.creator;
    this.creator_alloc = creatorAlloc;
    this.balances = new Map();
    this.last_near_out = 0n;
    if (creatorAlloc > 0n) this.balances.set(this.creator, creatorAlloc);
  }

  balanceOf(account) {
    return this.balances.get(account) || 0n;
  }

  _setBalance(account, value) {
    if (value === 0n) this.balances.delete(account);
    else this.balances.set(account, value);
  }

  _checkSell() {}

  _afterSell() {}

  buy(account, nearYocto, minOut, now) {
    checkAccount(account);
    const t = this._clock(now);
    const n = big(nearYocto, 'near');
    const out = this._poolBuy(n, big(minOut, 'min_tokens_out'));
    this.last_now = t;
    this._applyBuy(n, out);
    this.balances.set(account, this.balanceOf(account) + out);
    this._emit('buy', t, { account, near_in: n, tokens_out: out });
    return out;
  }

  sell(account, amount, minNearOut, now) {
    checkAccount(account);
    const t = this._clock(now);
    const x = big(amount, 'amount');
    if (x === 0n) fail('E_AMOUNT', 'amount must be positive');
    const held = this.balanceOf(account);
    if (x > held) fail('E_BALANCE', `balance is ${held} units`);
    this._checkSell(account, x, t);
    const nearOut = this._poolSell(x, big(minNearOut, 'min_near_out'));
    this.last_now = t;
    this._applySell(x, nearOut);
    this._setBalance(account, held - x);
    this._afterSell(account, t);
    this.last_near_out = nearOut;
    this._emit('sell', t, { account, tokens_in: x, near_out: nearOut });
    return nearOut;
  }

  transfer(account, receiver, amount, now) {
    checkAccount(account);
    checkAccount(receiver);
    const t = this._clock(now);
    if (receiver === account) fail('E_SELF', 'sender and receiver are the same');
    const x = big(amount, 'amount');
    if (x === 0n) fail('E_AMOUNT', 'amount must be positive');
    const held = this.balanceOf(account);
    if (x > held) fail('E_BALANCE', `balance is ${held} units`);
    this.last_now = t;
    this._setBalance(account, held - x);
    this.balances.set(receiver, this.balanceOf(receiver) + x);
    this._emit('ft_transfer', t, { old_owner_id: account, new_owner_id: receiver, amount: x });
    return x;
  }

  getState(now) {
    return { pool_tokens: this.pool_tokens, pool_near: this.pool_near, now: big64(now, 'now') };
  }

  getAccount(account) {
    return { balance: this.balanceOf(account) };
  }
}

// Baseline 2: the common anti-dump design. Each wallet may sell at most
// max_sell_bps of supply per transaction and must wait cooldown_ns between sells.
export class PerWalletToken extends NaiveToken {
  constructor(params, nowNs) {
    super(params, nowNs);
    const bps = params.max_sell_bps === undefined ? 50n : big(params.max_sell_bps, 'max_sell_bps');
    this.max_sell_units = (this.total_supply * bps) / 10000n;
    this.cooldown_ns = params.cooldown_ns === undefined ? 60n * SEC : big(params.cooldown_ns, 'cooldown_ns');
    this.last_sell = new Map();
  }

  _checkSell(account, x, t) {
    if (x > this.max_sell_units) fail('E_MAX_SELL', `at most ${this.max_sell_units} units per sell`);
    const last = this.last_sell.get(account);
    if (last !== undefined && t - last < this.cooldown_ns) {
      const left = (this.cooldown_ns - (t - last) + SEC - 1n) / SEC;
      fail('E_COOLDOWN', `${left} seconds of cooldown left`);
    }
  }

  _afterSell(account, t) {
    this.last_sell.set(account, t);
  }
}

// Greedy sellers (simulation drivers, not part of the contract)

// Sells loud tokens from a set of wallets through the door with a simple batch
// strategy. It is not the fastest possible exit: the gate at the top of
// _shout() waits for the current batch to near its expiry before it shouts
// again, so near the end of a position the cap can have room while no exit is
// open. It never shouts less than dust_units: the token accepts a smaller shout
// only for the whole loud balance of a wallet with no other open exit, and
// this driver does not use that.
// It keeps one batch of exits ready at all times: a new batch is shouted early
// enough to become ready before the previous one expires, and each batch is
// sized to the most the cap could release during one exit window.
// setTarget(units) limits the cumulative amount it tries to sell.
export class GreedyLoudSeller {
  constructor(token, wallets, stepNs) {
    this.token = token;
    this.wallets = [...wallets];
    this.step_ns = big(stepNs, 'stepNs');
    this.target = null;
    this.sold = 0n;
    this.near_out = 0n;
    this.open = [];
    this.cover_until = -1n;
    this.first_shout_at = null;
    this.shouted = 0n;
    this.batch_units = token.cap_units +
      mulDiv(token.cap_units, token.exit_window_ns + this.step_ns, token.cap_window_ns) + 1n;
  }

  setTarget(units) {
    this.target = units;
  }

  holdings() {
    let sum = 0n;
    for (const w of this.wallets) sum += this.token._loudOf(w);
    for (const id of this.open) {
      const ex = this.token.exits.get(id);
      if (ex) sum += ex.remaining;
    }
    return sum;
  }

  _openRemaining() {
    let sum = 0n;
    for (const id of this.open) {
      const ex = this.token.exits.get(id);
      if (ex) sum += ex.remaining;
    }
    return sum;
  }

  // Returns units sold during this step.
  step(now) {
    const token = this.token;
    const t = big(now, 'now');
    let soldNow = 0n;
    const still = [];
    for (const id of this.open) {
      const ex = token.exits.get(id);
      if (!ex) continue;
      if (t > ex.expires_at) {
        token.hush(ex.owner, id, t);
        continue;
      }
      if (t >= ex.ready_at) {
        try {
          const fill = token.leave(ex.owner, id, 0n, t);
          soldNow += fill;
          this.near_out += token.last_near_out;
        } catch (e) {
          if (e.code !== 'E_CAP' && e.code !== 'E_POOL_EMPTY' && e.code !== 'E_AMOUNT') throw e;
        }
      }
      if (token.exits.has(id)) still.push(id);
    }
    this.open = still;
    this.sold += soldNow;
    this._shout(t);
    return soldNow;
  }

  _shout(t) {
    const token = this.token;
    if (t + token.notice_ns + this.step_ns < this.cover_until) return;
    const dust = token.dust_units;
    // Sub-dust remainders cannot be shouted; move them to a wallet that can.
    if (this.wallets.length > 1) {
      let big_ = null;
      for (const w of this.wallets) if (token._loudOf(w) >= dust) { big_ = w; break; }
      if (big_ !== null) {
        for (const w of this.wallets) {
          const l = token._loudOf(w);
          if (w !== big_ && l > 0n && l < dust) token.transferLoud(w, big_, l, t);
        }
      }
    }
    let free = 0n;
    for (const w of this.wallets) free += token._loudOf(w);
    let want = free;
    if (this.target !== null) {
      const room = this.target - this.sold - this._openRemaining();
      want = room > 0n ? min(want, room) : 0n;
    }
    want = min(want, this.batch_units);
    if (want < dust) return;
    let left = want;
    let any = false;
    for (const w of this.wallets) {
      if (left < dust) break;
      const l = token._loudOf(w);
      if (l < dust) continue;
      let a = min(l, left);
      if (l - a < dust) a = l;
      try {
        const id = token.shout(w, a, t);
        this.open.push(id);
        this.shouted += a;
        left = a > left ? 0n : left - a;
        any = true;
      } catch (e) {
        if (e.code !== 'E_TOO_MANY') throw e;
      }
    }
    if (any) {
      this.cover_until = t + token.notice_ns + token.exit_window_ns;
      if (this.first_shout_at === null) this.first_shout_at = t;
    }
  }
}

// Sells from a set of wallets on NaiveToken or PerWalletToken as fast as the
// token allows. One sell attempt per wallet per step.
export class GreedyPlainSeller {
  constructor(token, wallets) {
    this.token = token;
    this.wallets = [...wallets];
    this.target = null;
    this.sold = 0n;
    this.near_out = 0n;
  }

  setTarget(units) {
    this.target = units;
  }

  holdings() {
    let sum = 0n;
    for (const w of this.wallets) sum += this.token.balanceOf(w);
    return sum;
  }

  step(now) {
    const token = this.token;
    const t = big(now, 'now');
    let soldNow = 0n;
    for (const w of this.wallets) {
      let x = token.balanceOf(w);
      if (token.max_sell_units !== undefined) x = min(x, token.max_sell_units);
      if (this.target !== null) {
        const room = this.target - this.sold - soldNow;
        x = room > 0n ? min(x, room) : 0n;
      }
      x = min(x, token.maxSellable());
      if (x === 0n) continue;
      try {
        this.near_out += token.sell(w, x, 0n, t);
        soldNow += x;
      } catch (e) {
        if (e.code !== 'E_COOLDOWN' && e.code !== 'E_POOL_EMPTY' && e.code !== 'E_AMOUNT') throw e;
      }
    }
    this.sold += soldNow;
    return soldNow;
  }
}

export function makeToken(rule, params, nowNs) {
  if (rule === 'loud') return new LoudToken(params, nowNs);
  if (rule === 'naive') return new NaiveToken(params, nowNs);
  if (rule === 'per_wallet') return new PerWalletToken(params, nowNs);
  fail('E_PARAMS', `unknown rule ${rule}`);
}

export function makeSeller(rule, token, wallets, stepNs) {
  return rule === 'loud' ? new GreedyLoudSeller(token, wallets, stepNs) : new GreedyPlainSeller(token, wallets);
}

// One insider holding insiderShareBps of supply, split evenly across `wallets`
// accounts at launch, sells with the greedy seller of that rule (for LOUD the
// batch strategy above, which can leave gaps). The creator allocation is set
// to the insider share, replacing the preset value. Community buyers put
// communityNear into the pool right after the launch window, then the insider
// starts: its first action is one tick (at most 60 s) after the first series
// point, and under LOUD that action is a shout.
//
// The share comes from the creator allocation (up to 20%); anything above that
// is bought by the insider at launch.
//
// Returns one point per stepNs:
//   t                     seconds since launch
//   insiderSold           fraction of the insider's holdings sold so far
//   insiderSoldUnits      the same in token units (decimal string)
//   insiderNear           NEAR the insider received so far
//   price                 spot price, NEAR per token
//   poolNear              real NEAR in the pool
//   quietHolderExitPrice  NEAR per token an ordinary holder gets when selling
//                         0.01% of supply at that moment
//   announced             share of supply sitting in open exits (LOUD only)
export function runSplitScenario({
  rule = 'loud',
  wallets = 1,
  insiderShareBps = 500,
  params = PRESETS.standard,
  horizonNs = 6n * HOUR,
  stepNs = 60n * SEC,
  communityNear = 300n * NEAR,
  communityBuys = 30,
} = {}) {
  const share = big(insiderShareBps, 'insiderShareBps');
  const horizon = big(horizonNs, 'horizonNs');
  const step = big(stepNs, 'stepNs');
  if (step <= 0n || horizon < step) fail('E_PARAMS', 'bad horizon or step');
  const n = Number(wallets);
  if (!Number.isInteger(n) || n < 1) fail('E_PARAMS', 'wallets must be a positive integer');

  const names = Array.from({ length: n }, (_, i) => `insider-${i}`);
  const allocBps = min(share, 2000n);
  const token = makeToken(rule, { ...params, creator: names[0], creator_alloc_bps: allocBps }, 0n);
  if (share > allocBps) {
    const extra = (token.total_supply * (share - allocBps)) / 10000n;
    const R = token.virtual_near + token.pool_near;
    const cost = (R * extra) / (token.pool_tokens - extra) + 1n;
    token.buy(names[0], cost, 0n, 0n);
  }
  const held = token.balanceOf(names[0]);
  const each = held / BigInt(n);
  for (let i = 1; i < n; i++) {
    if (rule === 'loud') token.transferLoud(names[0], names[i], each, 0n);
    else token.transfer(names[0], names[i], each, 0n);
  }

  const loudWindow = big(params.loud_window_ns, 'loud_window_ns');
  const start = loudWindow;
  const buys = Number(communityBuys);
  const perBuy = big(communityNear, 'communityNear') / BigInt(buys);
  for (let i = 0; i < buys; i++) token.buy(`holder-${i}`, perBuy, 0n, start);

  // The per-wallet cooldown is 60 s, so the insider acts at least once a minute.
  const parts = (step + 60n * SEC - 1n) / (60n * SEC);
  const tick = step / parts;
  const seller = makeSeller(rule, token, names, tick);
  const refLot = token.total_supply / 10000n;
  const series = [];
  const point = (t) => ({
    t: Number(t / SEC),
    insiderSold: Number((seller.sold * 1_000_000n) / held) / 1e6,
    insiderSoldUnits: seller.sold.toString(),
    insiderNear: Number(seller.near_out / 10n ** 18n) / 1e6,
    price: token.price(),
    poolNear: Number(token.pool_near / 10n ** 18n) / 1e6,
    quietHolderExitPrice: token.exitPrice(refLot),
    announced: rule === 'loud' ? Number((token.escrowed * 1_000_000n) / token.total_supply) / 1e6 : 0,
  });
  series.push(point(start));
  const steps = horizon / step;
  for (let k = 1n; k <= steps; k++) {
    for (let j = 1n; j <= parts; j++) {
      seller.step(start + (k - 1n) * step + j * tick);
    }
    series.push(point(start + k * step));
  }
  return series;
}
