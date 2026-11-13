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

// Final check of the split run. `attempts` are leave attempts with { filled, block_timestamp }.
export function evaluateSplit({ attempts, bucketAtStart, capUnits, capWindowNs, t0, t1, totalLeftDelta }) {
  const windowEnd = BigInt(t0) + BigInt(capWindowNs);
  let receiptsSum = 0n;
  let soldInWindow = 0n;
  let fills = 0;
  for (const a of attempts) {
    if (a.filled === null || a.filled === undefined) continue;
    const f = BigInt(a.filled);
    if (f === 0n) continue;
    fills += 1;
    receiptsSum += f;
    if (a.block_timestamp === null || a.block_timestamp === undefined || BigInt(a.block_timestamp) <= windowEnd) {
      soldInWindow += f;
    }
  }
  // The contract counter is the authority; receipts are the per-transaction evidence.
  const soldTotal = totalLeftDelta === null || totalLeftDelta === undefined ? receiptsSum : BigInt(totalLeftDelta);
  const bound = capBound({ bucketAtStart, capUnits, t0, t1, capWindowNs });
  const looseBound = BigInt(bucketAtStart) + BigInt(capUnits);
  const pass = soldTotal > 0n && soldTotal <= bound && soldInWindow <= looseBound;
  return {
    fills,
    receiptsSum,
    soldInWindow,
    soldTotal,
    bound,
    looseBound,
    windowEnd,
    receiptsMatchCounter: soldTotal === receiptsSum,
    pass,
  };
}

export const txLink = (hash) => `${EXPLORER}/txns/${hash}`;
export const accountLink = (account) => `${EXPLORER}/address/${account}`;

// JSON.stringify replacer: BigInt -> decimal string.
export function jsonReplacer(_key, value) {
  return typeof value === 'bigint' ? value.toString() : value;
}
