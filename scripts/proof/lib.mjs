// Pure helpers for the proof run. No dependencies, no network, no clock.
// Covered by lib.test.mjs (node --test).

export const YOCTO = 10n ** 24n;
export const TGAS = 10n ** 12n;
export const ONE_TOKEN = 10n ** 18n;
export const STORAGE_PER_BYTE = 10n ** 19n; // yoctoNEAR per byte of account storage
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
  const minWallet = nearToYocto('0.1'); // gas for about 60 calls
  const maxWallet = nearToYocto('0.25');
  const fixed = tokenDeposit + insider + late + rootReserve;
  const need = fixed + minWallet * BigInt(wallets);
  const bal = BigInt(balance);
  let perWallet = bal > fixed ? (bal - fixed) / BigInt(wallets) : 0n;
  if (perWallet > maxWallet) perWallet = maxWallet;
  return { ok: bal >= need, need, tokenDeposit, insider, late, rootReserve, perWallet };
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
