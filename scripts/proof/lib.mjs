// Pure helpers for the proof run. No dependencies, no network, no clock.
// Covered by lib.test.mjs (node --test).

export const YOCTO = 10n ** 24n;
export const TGAS = 10n ** 12n;
export const ONE_TOKEN = 10n ** 18n;
export const STORAGE_PER_BYTE = 10n ** 19n; // yoctoNEAR per byte of account storage
// What one account pays the token once to be registered (SPEC section 7, NEP-145): 0.02 NEAR.
// The contract has the same constant; step 2 compares it with storage_balance_bounds().min.
export const STORAGE_MIN_YOCTO = 20_000_000_000_000_000_000_000n;
export const EXPLORER = 'https://testnet.nearblocks.io';

// "1.5" -> 1500000000000000000000000n
export function nearToYocto(near) {
  const [whole, frac = ''] = String(near).split('.');
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(frac) || frac.length > 24) {
    throw new Error(`bad NEAR amount: ${near}`);
  }
  return BigInt(whole) * YOCTO + BigInt(frac.padEnd(24, '0') || '0');
}

// yoctoNEAR -> "1.2345" (rounded down, for logs only)
export function yoctoToNear(yocto, digits = 4) {
  const v = BigInt(yocto);
  const whole = v / YOCTO;
  const frac = (v % YOCTO).toString().padStart(24, '0').slice(0, digits);
  return `${whole}.${frac}`;
}

// units -> whole tokens, rounded down (for logs only)
export function unitsToTokens(units) {
  return (BigInt(units) / ONE_TOKEN).toString();
}

// SPEC section 3, preset "demo". U128/U64 values are decimal strings (SPEC section 2).
export function presetParams(preset, creator) {
  if (preset !== 'demo') {
    throw new Error(`preset "${preset}" is not supported by the proof run (only "demo" fits the runtime limit)`);
  }
  return {
    total_supply: (1_000_000_000n * ONE_TOKEN).toString(),
    creator,
    creator_alloc_bps: 500,
    virtual_near: (5n * YOCTO).toString(),
    loud_window_ns: (120n * 10n ** 9n).toString(),
    notice_ns: (60n * 10n ** 9n).toString(),
    exit_window_ns: (600n * 10n ** 9n).toString(),
    cap_bps: 50,
    cap_window_ns: (600n * 10n ** 9n).toString(),
    name: 'LOUD',
    symbol: 'LOUD',
    icon: null,
  };
}

// Split `total` into `n` parts; the remainder goes to the last part so the sum is exact.
export function splitEvenly(total, n) {
  const t = BigInt(total);
  const each = t / BigInt(n);
  const parts = Array.from({ length: n }, () => each);
  parts[n - 1] += t - each * BigInt(n);
  return parts;
}

// Funding plan from the wasm size and the root balance. All values in yoctoNEAR.
export function budget({ wasmBytes, balance, wallets = 20 }) {
  const tokenDeposit = BigInt(wasmBytes) * STORAGE_PER_BYTE + nearToYocto('0.5'); // code + state margin
  const insider = nearToYocto('1.25'); // 1 NEAR buy + gas for 21 calls
  const late = nearToYocto('0.65'); // 0.5 NEAR buy + gas
  const rootReserve = nearToYocto('0.3'); // gas for account creation and deploy
  // Each split wallet pays its own registration with storage_deposit before it can receive
  // tokens. The insider is the creator, which `new` registers; the late buyer's registration
  // is taken out of the NEAR it attaches to its buy. So only the wallets need more.
  const registration = STORAGE_MIN_YOCTO;
  const minWallet = nearToYocto('0.1') + registration; // gas for about 60 calls + registration
  const maxWallet = nearToYocto('0.25') + registration;
  const fixed = tokenDeposit + insider + late + rootReserve;
  const need = fixed + minWallet * BigInt(wallets);
  const bal = BigInt(balance);
  let perWallet = bal > fixed ? (bal - fixed) / BigInt(wallets) : 0n;
  if (perWallet > maxWallet) perWallet = maxWallet;
  return { ok: bal >= need, need, tokenDeposit, insider, late, rootReserve, perWallet, registration };
}

// Text of a failed execution status, e.g. the contract panic message.
export function failureText(failure) {
  if (failure === undefined || failure === null) return null;
  const s = typeof failure === 'string' ? failure : JSON.stringify(failure);
  const m = s.match(/Smart contract panicked: ((?:[^"\\]|\\.)*)/);
  return (m ? m[1] : s).slice(0, 400);
}

// First SPEC error code (E_...) found in a text, or null.
export function errorCode(text) {
  if (!text) return null;
  const m = String(text).match(/\bE_[A-Z][A-Z_]*[A-Z]\b/);
  return m ? m[0] : null;
}

// NEP-297 events from receipt logs. `data` may be an object or a one-element array.
export function parseEvents(logs) {
  const out = [];
  for (const line of logs ?? []) {
    if (typeof line !== 'string' || !line.startsWith('EVENT_JSON:')) continue;
    try {
      const ev = JSON.parse(line.slice('EVENT_JSON:'.length));
      const items = Array.isArray(ev.data) ? ev.data : [ev.data];
      for (const data of items) out.push({ standard: ev.standard, event: ev.event, data: data ?? {} });
    } catch {
      // not an event we can read; ignore
    }
  }
  return out;
}

// Decode a base64 JSON return value ("123", 123 or "\"123\"") to a BigInt, or null.
export function returnValueBigInt(successValueB64) {
  if (typeof successValueB64 !== 'string' || successValueB64 === '') return null;
  try {
    const v = JSON.parse(Buffer.from(successValueB64, 'base64').toString('utf8'));
    if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
    if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  } catch {
    // fall through
  }
  return null;
}

// Units filled by a successful leave: the `leave` event first, the return value second.
export function leaveFilled({ logs, successValue }) {
  const ev = parseEvents(logs).find((e) => e.standard === 'loud' && e.event === 'leave');
  if (ev && /^\d+$/.test(String(ev.data.filled ?? ''))) {
    const remaining = /^\d+$/.test(String(ev.data.remaining ?? '')) ? BigInt(ev.data.remaining) : null;
    return { filled: BigInt(ev.data.filled), remaining };
  }
  const v = returnValueBigInt(successValue);
  return { filled: v, remaining: null };
}

// A decimal string (or a safe non-negative integer) as a BigInt; anything else is null.
export function decimalOrNull(v) {
  if (typeof v === 'string' && /^[0-9]+$/.test(v)) return BigInt(v);
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  return null;
}

// The `buy` event of the `loud` standard in the logs of a transaction, or null.
// A field the event does not carry, or that is not a decimal amount, is null.
export function buyEvent(logs) {
  const ev = parseEvents(logs).find((e) => e.standard === 'loud' && e.event === 'buy');
  if (!ev) return null;
  return {
    nearIn: decimalOrNull(ev.data.near_in),
    storagePaid: decimalOrNull(ev.data.storage_paid),
    tokensOut: decimalOrNull(ev.data.tokens_out),
    loud: typeof ev.data.loud === 'boolean' ? ev.data.loud : null,
  };
}

// Check of one buy against the storage rule: an account that is not registered yet pays
// STORAGE_MIN_YOCTO out of the attached NEAR, and only the rest goes into the pool.
//   attached               yoctoNEAR attached to the buy
//   registeredBefore       is_registered(buyer), read before the buy
//   poolNearBefore/After   get_state().pool_near on both sides of the buy (null: not read)
//   event                  buyEvent() of the transaction (null: no buy event found)
// The pool change read from the contract decides. The event is evidence: a field that is
// present and differs fails the check, a field that is absent is named in `notes` only.
export function evaluateBuy({ attached, registeredBefore, poolNearBefore, poolNearAfter, event, storageMin = STORAGE_MIN_YOCTO }) {
  const paid = BigInt(attached);
  const storagePaid = registeredBefore === true ? 0n : BigInt(storageMin);
  const nearIn = paid > storagePaid ? paid - storagePaid : 0n;
  const poolKnown = poolNearBefore !== null && poolNearBefore !== undefined
    && poolNearAfter !== null && poolNearAfter !== undefined;
  const poolDelta = poolKnown ? BigInt(poolNearAfter) - BigInt(poolNearBefore) : null;
  const reasons = [];
  const notes = [];
  if (typeof registeredBefore !== 'boolean') reasons.push('is_registered was not read before the buy');
  if (!poolKnown) reasons.push('pool_near was not read on both sides of the buy');
  else if (poolDelta !== nearIn) reasons.push(`pool_near changed by ${poolDelta}, expected ${nearIn}`);
  const ev = event ?? null;
  if (ev === null) {
    notes.push('no buy event was read');
  } else {
    if (ev.nearIn === null) notes.push('the buy event has no near_in');
    else if (ev.nearIn !== nearIn) reasons.push(`the buy event says near_in ${ev.nearIn}, expected ${nearIn}`);
    if (ev.storagePaid === null) notes.push('the buy event has no storage_paid');
    else if (ev.storagePaid !== storagePaid) reasons.push(`the buy event says storage_paid ${ev.storagePaid}, expected ${storagePaid}`);
  }
  const text = (v) => (v === null || v === undefined ? null : v.toString());
  return {
    pass: reasons.length === 0,
    reasons,
    notes,
    // The part that goes into receipts.json.
    record: {
      attached: paid.toString(),
      registered_before: typeof registeredBefore === 'boolean' ? registeredBefore : null,
      expected_storage_paid: storagePaid.toString(),
      expected_near_in: nearIn.toString(),
      pool_near_before: poolKnown ? BigInt(poolNearBefore).toString() : null,
      pool_near_after: poolKnown ? BigInt(poolNearAfter).toString() : null,
      pool_near_change: text(poolDelta),
      event_near_in: text(ev?.nearIn),
      event_storage_paid: text(ev?.storagePaid),
      pass: reasons.length === 0,
    },
  };
}

// NEAR held by the token account, split by what it is for. Inputs in yoctoNEAR and bytes.
//   spare         = balance - pool_near                  everything that is not pool liquidity
//   storage_stake = storage_bytes * 1e19                 what the protocol keeps locked for state
//   free          = spare - owed_total - storage_stake   what is left after those two
// Values are decimal strings; `free` is negative when the balance does not cover all three.
export function tokenNear({ balance, storageBytes, poolNear, owedTotal }) {
  const bal = BigInt(balance);
  const pool = BigInt(poolNear);
  const owed = BigInt(owedTotal);
  const stake = BigInt(storageBytes) * STORAGE_PER_BYTE;
  const spare = bal - pool;
  return {
    balance: bal.toString(),
    pool_near: pool.toString(),
    owed_total: owed.toString(),
    spare: spare.toString(),
    storage_bytes: Number(storageBytes),
    storage_stake: stake.toString(),
    free: (spare - owed - stake).toString(),
  };
}

// SPEC invariant 4: units that may leave in [t0, t1] given the bucket level at t0.
export function capBound({ bucketAtStart, capUnits, t0, t1, capWindowNs }) {
  const dt = BigInt(t1) > BigInt(t0) ? BigInt(t1) - BigInt(t0) : 0n;
  return BigInt(bucketAtStart) + (BigInt(capUnits) * dt) / BigInt(capWindowNs);
}

// Final check of the split run. `attempts` are leave attempts with
// { filled, block_timestamp, settled }. `pass` needs all of:
//   - the contract counter change is known and equals the sum of the per-transaction fills,
//   - at least one fill, each with a block time inside [t0, t1],
//   - the measurement covers the full cap window: t1 - t0 >= cap_window_ns (no tolerance;
//     the run waits for chain time to reach the window end before it closes the measurement),
//   - no fill whose payout receipts failed (settled === false),
//   - sold_total <= bound (SPEC invariant 4) and sold_in_window <= bucket_at_start + cap_units.
// `reasons` lists every condition that did not hold.
export function evaluateSplit({ attempts, bucketAtStart, capUnits, capWindowNs, t0, t1, totalLeftDelta }) {
  const start = BigInt(t0);
  const end = BigInt(t1);
  const windowNs = BigInt(capWindowNs);
  const windowEnd = start + windowNs;
  let receiptsSum = 0n;
  let soldInWindow = 0n;
  let fills = 0;
  let fillsWithoutTime = 0;
  let fillsOutsideMeasurement = 0;
  let unsettledFills = 0;
  for (const a of attempts) {
    if (a.filled === null || a.filled === undefined) continue;
    const f = BigInt(a.filled);
    if (f === 0n) continue;
    fills += 1;
    receiptsSum += f;
    if (a.settled === false) unsettledFills += 1;
    if (a.block_timestamp === null || a.block_timestamp === undefined) {
      // Without a block time the fill cannot be placed outside the window, so it counts inside.
      fillsWithoutTime += 1;
      soldInWindow += f;
      continue;
    }
    const ts = BigInt(a.block_timestamp);
    if (ts < start || ts > end) fillsOutsideMeasurement += 1;
    if (ts <= windowEnd) soldInWindow += f;
  }
  const counterKnown = totalLeftDelta !== null && totalLeftDelta !== undefined;
  // The contract counter is the authority; receipts are the per-transaction evidence.
  const soldTotal = counterKnown ? BigInt(totalLeftDelta) : receiptsSum;
  const receiptsMatchCounter = counterKnown && soldTotal === receiptsSum;
  const measuredNs = end > start ? end - start : 0n;
  const fullWindow = windowNs > 0n && measuredNs >= windowNs;
  const timestampsValid = start > 0n && end > start && fillsWithoutTime === 0 && fillsOutsideMeasurement === 0;
  const bound = capBound({ bucketAtStart, capUnits, t0, t1, capWindowNs });
  const looseBound = BigInt(bucketAtStart) + BigInt(capUnits);
  const reasons = [];
  if (!counterKnown) reasons.push('the contract counter was not read');
  else if (!receiptsMatchCounter) reasons.push(`the receipts sum ${receiptsSum} differs from the contract counter change ${soldTotal}`);
  if (fills === 0) reasons.push('no leave call filled');
  if (soldTotal <= 0n) reasons.push('nothing left according to the contract counter');
  if (fillsWithoutTime > 0) reasons.push(`${fillsWithoutTime} fills have no block time`);
  if (fillsOutsideMeasurement > 0) reasons.push(`${fillsOutsideMeasurement} fills lie outside the measured interval`);
  if (!(start > 0n && end > start)) reasons.push('the measurement interval is empty');
  if (!fullWindow) reasons.push(`measured ${measuredNs} ns, less than the cap window of ${windowNs} ns`);
  if (unsettledFills > 0) reasons.push(`${unsettledFills} fills have a failed payout receipt`);
  if (soldTotal > bound) reasons.push(`sold ${soldTotal} is above the bound ${bound}`);
  if (soldInWindow > looseBound) reasons.push(`sold in the window ${soldInWindow} is above ${looseBound}`);
  return {
    fills,
    receiptsSum,
    soldInWindow,
    soldTotal,
    bound,
    looseBound,
    windowEnd,
    measuredNs,
    fullWindow,
    timestampsValid,
    unsettledFills,
    counterKnown,
    receiptsMatchCounter,
    reasons,
    pass: reasons.length === 0,
  };
}

// Settlement of one transaction result (RPC `send_tx` / `tx` with wait_until FINAL).
// The contract pays NEAR with a detached transfer followed by its `on_payout` callback,
// so a failed payout does not change the top-level status. It shows as a failed entry of
// `receipts_outcome` (the transfer) and as a `payout_failed` event in the log of the
// callback receipt, which itself succeeds when it records the unpaid amount.
// `settled`: the top-level status is a success, there is at least one receipt outcome,
// every receipt outcome is a success (SuccessValue or SuccessReceiptId), and no receipt
// log carries a `payout_failed` event of the `loud` standard.
export function receiptSettlement(result) {
  const outcomes = Array.isArray(result?.receipts_outcome) ? result.receipts_outcome : [];
  const failed = [];
  for (const r of outcomes) {
    const unpaid = parseEvents(r?.outcome?.logs).find((e) => e.standard === 'loud' && e.event === 'payout_failed');
    if (unpaid) {
      failed.push({
        receipt_id: r?.id ?? null,
        executor: r?.outcome?.executor_id ?? null,
        error: `payout_failed: ${String(unpaid.data.amount ?? '?')} yoctoNEAR owed to ${String(unpaid.data.account ?? '?')}`.slice(0, 400),
      });
    }
    const st = r?.outcome?.status;
    const ok = st !== null && typeof st === 'object'
      && (typeof st.SuccessValue === 'string' || typeof st.SuccessReceiptId === 'string');
    if (ok) continue;
    const why = st !== null && typeof st === 'object' && st.Failure !== undefined ? st.Failure : (st ?? 'no status');
    failed.push({ receipt_id: r?.id ?? null, executor: r?.outcome?.executor_id ?? null, error: failureText(why) });
  }
  const top = result?.status;
  const topOk = top !== null && typeof top === 'object' && typeof top.SuccessValue === 'string';
  return { receipts: outcomes.length, failed, settled: topOk && outcomes.length > 0 && failed.length === 0 };
}

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// Base58 (Bitcoin alphabet, as NEAR uses for hashes) of a byte array.
export function base58Encode(bytes) {
  const src = Uint8Array.from(bytes);
  let zeros = 0;
  while (zeros < src.length && src[zeros] === 0) zeros += 1;
  let n = 0n;
  for (const b of src) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58_ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  return '1'.repeat(zeros) + out;
}

// A NEAR transaction hash: base58 of 32 bytes.
export const isTxHash = (v) => typeof v === 'string' && /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(v);

// Transaction identifier in a faucet response body, if it carries one. The response
// shape is not documented, so this reads the usual places of an RPC transaction result
// and returns null for anything else (plain text, HTML, an empty body).
// -> { hash, account, outcome, error } in the shape of a receipts.json transaction, or null.
export function faucetTx(body) {
  let doc;
  try {
    doc = JSON.parse(body);
  } catch {
    return null;
  }
  if (isTxHash(doc)) return { hash: doc, account: null, outcome: 'unknown', error: null };
  if (doc === null || typeof doc !== 'object') return null;
  const inner = doc.result !== null && typeof doc.result === 'object' ? doc.result : {};
  const hash = [
    doc.transaction?.hash, doc.transaction_outcome?.id, inner.transaction?.hash, inner.transaction_outcome?.id,
    doc.txHash, doc.tx_hash, doc.transactionHash, doc.transaction_hash, doc.hash,
  ].find(isTxHash);
  if (!hash) return null;
  const signer = doc.transaction?.signer_id ?? inner.transaction?.signer_id;
  const st = doc.status ?? inner.status;
  let outcome = 'unknown';
  let error = null;
  if (st !== null && typeof st === 'object') {
    if (st.Failure !== undefined) {
      outcome = 'failure';
      error = failureText(st.Failure);
    } else if (typeof st.SuccessValue === 'string') {
      outcome = 'success';
    }
  }
  return { hash, account: typeof signer === 'string' ? signer : null, outcome, error };
}

// Constructor arguments that get_params() must return unchanged (SPEC section 3).
export const PARAM_KEYS = [
  'total_supply', 'creator', 'creator_alloc_bps', 'virtual_near', 'loud_window_ns',
  'notice_ns', 'exit_window_ns', 'cap_bps', 'cap_window_ns',
];

// Differences between the intended constructor arguments and the on-chain get_params()
// result, including the two values SPEC section 3 derives at launch. Empty when all match.
export function paramMismatches(intended, onchain) {
  const o = onchain !== null && typeof onchain === 'object' ? onchain : {};
  const out = [];
  for (const key of PARAM_KEYS) {
    if (o[key] === undefined || o[key] === null || String(o[key]) !== String(intended[key])) {
      out.push(`${key}: intended ${intended[key]}, on chain ${o[key]}`);
    }
  }
  const dec = (v) => ((typeof v === 'string' || typeof v === 'number') && /^\d+$/.test(String(v)) ? BigInt(v) : null);
  const capUnits = (BigInt(intended.total_supply) * BigInt(intended.cap_bps)) / 10000n;
  if (dec(o.cap_units) !== capUnits) out.push(`cap_units: intended ${capUnits}, on chain ${o.cap_units}`);
  const launch = dec(o.launch_ts);
  const loudUntil = dec(o.loud_until);
  if (launch === null || loudUntil === null || loudUntil !== launch + BigInt(intended.loud_window_ns)) {
    out.push(`loud_until: expected launch_ts + ${intended.loud_window_ns}, on chain launch_ts ${o.launch_ts}, loud_until ${o.loud_until}`);
  }
  return out;
}

export const txLink = (hash) => `${EXPLORER}/txns/${hash}`;
export const accountLink = (account) => `${EXPLORER}/address/${account}`;

// JSON.stringify replacer: BigInt -> decimal string.
export function jsonReplacer(_key, value) {
  return typeof value === 'bigint' ? value.toString() : value;
}

// Transaction records and outcome counts

// What a transaction looks like inside receipts.json. `r` is the result of one send:
// { hash, account, outcome, error, method?, earlierAttempts? }. When the send was signed and
// broadcast more than once (a new nonce or block hash after InvalidNonce / Expired), the
// hashes of the earlier broadcasts are kept under `earlier_attempts`, oldest first.
export function txRecord(r, extra = {}) {
  const rec = { hash: r.hash, account: r.account, outcome: r.outcome, error: r.error, ...extra };
  // The contract method, for a function call. Other transactions have no `call` key.
  if (typeof r.method === 'string' && r.method !== '') rec.call = r.method;
  const earlier = (r.earlierAttempts ?? []).filter((h) => typeof h === 'string' && h !== '');
  if (earlier.length > 0) rec.earlier_attempts = [...earlier];
  return rec;
}

// The four things that can be said about a recorded transaction:
//   "success"         executed and succeeded
//   "executed_failed" executed on chain and failed (outcome "failure"; the error is on record)
//   "not_executed"    a node refused it before execution (outcome "invalid"), or it has no
//                     hash because the script failed before it could broadcast it
//   "unresolved"      it was broadcast (it has a hash) and no RPC endpoint returned a final
//                     result: it may never have executed, or it may have executed
export function outcomeClass(rec) {
  if (rec?.outcome === 'success') return 'success';
  if (rec?.outcome === 'failure') return 'executed_failed';
  if (rec?.outcome === 'invalid') return 'not_executed';
  return rec?.hash ? 'unresolved' : 'not_executed';
}

// Whether a record is worth one more status query by hash: its outcome is unknown, or a
// node refused it with InvalidNonce. The second case covers a transaction that was posted
// twice after a transport failure: the second post is refused because the first one landed.
export function needsLookup(rec) {
  if (!rec?.hash) return false;
  if (rec.outcome === 'unknown') return true;
  return rec.outcome === 'invalid' && /InvalidNonce/.test(String(rec.error ?? ''));
}

// Earlier broadcast hashes of a record whose own outcome is not known: no entry in
// `earlier_attempt_outcomes`, or an entry that says "unknown".
export function unresolvedEarlier(rec) {
  const hashes = Array.isArray(rec?.earlier_attempts) ? rec.earlier_attempts : [];
  const outcomes = Array.isArray(rec?.earlier_attempt_outcomes) ? rec.earlier_attempt_outcomes : [];
  return hashes.filter((h) => {
    const o = outcomes.find((x) => x?.hash === h);
    return !o || outcomeClass(o) === 'unresolved';
  });
}

// Counts for step 9 over the leave records ({ outcome, hash, filled, error_code, settled }).
export function leaveCounts(attempts) {
  const c = {
    calls: attempts.length,
    fills: 0,
    cap_hits: 0,
    expired: 0,
    other_failures: 0, // executed and failed with something other than E_CAP / E_EXPIRED
    executed_failed: 0, // every executed call that failed: cap_hits + expired + other_failures
    not_executed: 0,
    unresolved: 0,
    payout_calls: 0, // successful leaves
    payouts_settled: 0,
    earlier_attempts: 0, // earlier broadcasts that were replaced by a retry
  };
  for (const a of attempts) {
    const cls = outcomeClass(a);
    if (a.filled !== null && a.filled !== undefined && BigInt(a.filled) > 0n) c.fills += 1;
    if (cls === 'success') {
      c.payout_calls += 1;
      if (a.settled === true) c.payouts_settled += 1;
    } else if (cls === 'executed_failed') {
      c.executed_failed += 1;
      if (a.error_code === 'E_CAP') c.cap_hits += 1;
      else if (a.error_code === 'E_EXPIRED') c.expired += 1;
      else c.other_failures += 1;
    } else if (cls === 'not_executed') {
      c.not_executed += 1;
    } else {
      c.unresolved += 1;
    }
    if (Array.isArray(a.earlier_attempts)) c.earlier_attempts += a.earlier_attempts.length;
  }
  return c;
}

// The one-line step 9 result. Three groups stay apart: executed and failed (with the
// error code), not executed, and unresolved.
export function leaveCountsText(c, wallets) {
  return `${c.calls} leave calls from ${wallets} wallets: ${c.fills} filled; `
    + `${c.executed_failed} executed and failed (${c.cap_hits} E_CAP, ${c.expired} E_EXPIRED, ${c.other_failures} other); `
    + `${c.not_executed} not executed (refused before execution or never broadcast); `
    + `${c.unresolved} unresolved (broadcast, outcome not confirmed by polling or by the later lookup by hash)`
    + (c.earlier_attempts > 0 ? `; earlier broadcasts replaced by a retry and listed as earlier_attempts: ${c.earlier_attempts}` : '')
    + `; ${c.payouts_settled} of ${c.payout_calls} successful leaves have no failed receipt and no payout_failed event`;
}

// Run-level summary of the transactions the script sent whose outcome is not known.
// `records` are receipts.json transaction records; earlier broadcasts count as well.
// -> { count, hashes, note }; `note` is one plain sentence block, or null when count is 0.
export function unresolvedSummary(records) {
  const hashes = [];
  for (const rec of records ?? []) {
    if (outcomeClass(rec) === 'unresolved') hashes.push(rec.hash);
    hashes.push(...unresolvedEarlier(rec));
  }
  const count = hashes.length;
  const note = count === 0 ? null
    : `${count} ${count === 1 ? 'transaction that the run sent has' : 'transactions that the run sent have'} no confirmed outcome: `
      + 'no final result was obtained, neither while polling nor from the later lookup by hash, which stops at the time limit of the run. '
      + `${count === 1 ? 'It is' : 'They are'} listed with the outcome "unknown" or under earlier_attempts. `
      + `It is not known whether ${count === 1 ? 'it' : 'each of them'} never executed or executed and failed. `
      + 'The cap check of step 10 rests on the contract counter, not on these statuses.';
  return { count, hashes, note };
}
