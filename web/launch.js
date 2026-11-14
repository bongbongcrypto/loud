// Launch your own LOUD token on NEAR testnet (web/launch.html).
//
// One transaction from a test wallet in this browser to a new sub-account of it:
// CreateAccount, Transfer (the storage deposit), DeployContract (web/loud.wasm) and
// FunctionCall `new`. It adds no access key, so the token account has no key from its
// first block. Afterwards the page reads the chain and checks four things: the account
// exists, its access key list is empty, get_params (and ft_metadata) equal what was asked,
// and its code hash equals the hash of the published wasm.
//
// The logic at the top is DOM-free: tests (launch.test.mjs) and the on-chain check
// (launch-e2e.mjs) import it. Every function that talks to the chain takes the chain
// module (web/chain.js, or the mock below) as an argument. The page controller at the
// bottom runs only in a browser page that has the launch form.

import * as realChain from './chain.js';
import { parseDecimal, fmtNear } from './ui-logic.js';

export const NEAR = 10n ** 24n;
export const TGAS = 10n ** 12n;
export const SEC_NS = 10n ** 9n;
export const DAY_S = 86_400;
export const WEEK_S = 7 * DAY_S;
// Same as the presets of SPEC section 3: 1,000,000,000 tokens with 18 decimals.
export const TOTAL_SUPPLY = 10n ** 27n;
// Deposit to the token account, sized as the deploy scripts size it: the code at the
// protocol's storage price, plus a margin for the contract state.
export const STORAGE_PER_BYTE = 10n ** 19n;
export const STATE_MARGIN = NEAR / 2n;
// What the launching wallet keeps back for the gas of the launch transaction.
export const FEE_RESERVE = NEAR / 20n;
export const NEW_GAS = 100n * TGAS;
// A deploy carries the whole wasm, so the page waits longer for it than for a call.
export const CONFIRM_MS = 180_000;
export const WALLET_KEY = 'loud.live.wallets.v1'; // the main page's test wallets
export const LAUNCHES_KEY = 'loud.launch.tokens.v1';
export const MAX_LAUNCHES = 20;
export const FAUCET_LIMIT = 'The public testnet faucet limits how many accounts one network address can create. Try again later or from another network.';
export const MOCK_BANNER = 'MOCK: no chain, invented transactions';

const enc = new TextEncoder();
const bytesOf = (s) => enc.encode(String(s ?? '')).length;

// ---------------------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------------------

export const UNITS = Object.freeze({ s: 1, min: 60, h: 3600, d: DAY_S });
export const UNIT_LABELS = Object.freeze({ s: 'seconds', min: 'minutes', h: 'hours', d: 'days' });

// The contract's bounds (SPEC section 3, contracts/loud/src/lib.rs `new`) and the exact
// message it panics with when a value is outside them.
export const BOUNDS = Object.freeze({
  creator_alloc_bps: { min: 0n, max: 2000n, error: 'E_PARAMS: creator_alloc_bps must be 0 ..= 2000' },
  virtual_near: { min: 10n ** 23n, max: 10n ** 30n, error: 'E_PARAMS: virtual_near must be 10^23 ..= 10^30 yoctoNEAR' },
  loud_window_ns: { min: 60n * SEC_NS, max: BigInt(WEEK_S) * SEC_NS, error: 'E_PARAMS: loud_window_ns must be 60 s ..= 7 days' },
  notice_ns: { min: 30n * SEC_NS, max: BigInt(WEEK_S) * SEC_NS, error: 'E_PARAMS: notice_ns must be 30 s ..= 7 days' },
  exit_window_ns: { min: 60n * SEC_NS, max: BigInt(WEEK_S) * SEC_NS, error: 'E_PARAMS: exit_window_ns must be 60 s ..= 7 days' },
  cap_bps: { min: 1n, max: 1000n, error: 'E_PARAMS: cap_bps must be 1 ..= 1000' },
  cap_window_ns: { min: 60n * SEC_NS, max: BigInt(WEEK_S) * SEC_NS, error: 'E_PARAMS: cap_window_ns must be 60 s ..= 7 days' },
});
export const NAME_MAX_BYTES = 64;
export const SYMBOL_MAX_BYTES = 16;
export const NAME_ERROR = 'E_PARAMS: name must be at most 64 bytes';
export const SYMBOL_ERROR = 'E_PARAMS: symbol must be at most 16 bytes';

// The form, as typed. Durations are [value, unit].
//   { name, symbol, creatorPct, virtualNear, loudWindow, notice, exitWindow, capPct, capWindow }
export const FIELDS = Object.freeze([
  { key: 'name', label: 'Name' },
  { key: 'symbol', label: 'Symbol' },
  { key: 'creatorPct', label: 'Creator allocation, % of supply', param: 'creator_alloc_bps' },
  { key: 'virtualNear', label: 'Virtual NEAR reserve', param: 'virtual_near' },
  { key: 'loudWindow', label: 'Launch window', param: 'loud_window_ns', duration: true },
  { key: 'notice', label: 'Notice', param: 'notice_ns', duration: true },
  { key: 'exitWindow', label: 'Exit window', param: 'exit_window_ns', duration: true },
  { key: 'capPct', label: 'Cap, % of supply per cap window', param: 'cap_bps' },
  { key: 'capWindow', label: 'Cap window', param: 'cap_window_ns', duration: true },
]);

export const PRESETS = Object.freeze({
  standard: Object.freeze({
    label: 'Standard',
    note: 'SPEC standard preset: 5% creator allocation, launch window 10 min, notice 30 min, exit window 60 min, cap 0.5% per 60 min.',
    creatorPct: '5', virtualNear: '100', loudWindow: ['10', 'min'], notice: ['30', 'min'], exitWindow: ['60', 'min'], capPct: '0.5', capWindow: ['60', 'min'],
  }),
  quick: Object.freeze({
    label: 'Try in 5 minutes',
    note: 'Buys in the first 5 min are loud, later buys are quiet. Notice 1 min, exit window 10 min, cap 0.5% per 5 min: you see both kinds of token within minutes.',
    creatorPct: '0', virtualNear: '100', loudWindow: ['5', 'min'], notice: ['1', 'min'], exitWindow: ['10', 'min'], capPct: '0.5', capWindow: ['5', 'min'],
  }),
  long: Object.freeze({
    label: 'Long demo',
    note: 'Every buy for 7 days is loud. Notice 1 min, exit window 30 min, cap 0.5% per 10 min, as on the page\'s live token.',
    creatorPct: '0', virtualNear: '100', loudWindow: ['7', 'd'], notice: ['1', 'min'], exitWindow: ['30', 'min'], capPct: '0.5', capWindow: ['10', 'min'],
  }),
});
export const DEFAULT_PRESET = 'quick';

export function presetForm(key, base = {}) {
  const p = PRESETS[key];
  if (!p) throw new Error(`unknown preset ${key}`);
  return {
    name: base.name ?? 'My loud token',
    symbol: base.symbol ?? 'MINE',
    creatorPct: p.creatorPct,
    virtualNear: p.virtualNear,
    loudWindow: [...p.loudWindow],
    notice: [...p.notice],
    exitWindow: [...p.exitWindow],
    capPct: p.capPct,
    capWindow: [...p.capWindow],
  };
}

const FORMAT_NUMBER = 'Enter a number, for example 10 or 2.5.';

// [value, unit] -> whole seconds. Throws a page message for text that is not a duration.
export function durationSeconds(d) {
  const [value, unit] = Array.isArray(d) ? d : [d, 's'];
  const per = UNITS[unit];
  if (!per) throw new Error('Pick a unit.');
  let milli;
  try {
    milli = parseDecimal(String(value ?? '').trim(), 3);
  } catch {
    throw new Error(FORMAT_NUMBER);
  }
  const ms = milli * BigInt(per);
  if (ms % 1000n !== 0n) throw new Error('Use whole seconds.');
  return ms / 1000n;
}

// Seconds -> [value, unit] in the largest unit that divides it.
export function secondsToDuration(seconds) {
  const s = BigInt(seconds);
  for (const unit of ['d', 'h', 'min']) {
    const per = BigInt(UNITS[unit]);
    if (s > 0n && s % per === 0n) return [(s / per).toString(), unit];
  }
  return [s.toString(), 's'];
}

export function fmtSeconds(seconds) {
  const [v, unit] = secondsToDuration(seconds);
  return unit === 'd' ? `${v} ${v === '1' ? 'day' : 'days'}` : unit === 'h' ? `${v} h` : `${v} ${unit}`;
}

function pctToBps(text) {
  try {
    return parseDecimal(String(text ?? '').trim(), 2);
  } catch (e) {
    throw new Error(/decimal places/.test(e.message) ? 'At most 2 decimal places (0.01%).' : FORMAT_NUMBER);
  }
}

// The first bound the contract's `new` would refuse, as its message, or null. Same order
// as the contract.
export function contractCheck(params, tokenId = null) {
  const v = (k) => BigInt(params[k]);
  const s = v('total_supply');
  if (s < 10n ** 24n || s > 10n ** 30n) return 'E_PARAMS: total_supply must be 10^24 ..= 10^30 units';
  for (const k of ['creator_alloc_bps', 'virtual_near', 'loud_window_ns', 'notice_ns', 'exit_window_ns', 'cap_bps', 'cap_window_ns']) {
    const b = BOUNDS[k];
    if (v(k) < b.min || v(k) > b.max) return b.error;
  }
  if (tokenId && params.creator === tokenId) return 'E_PARAMS: creator cannot be the token account';
  if (bytesOf(params.name) > NAME_MAX_BYTES) return NAME_ERROR;
  if (bytesOf(params.symbol) > SYMBOL_MAX_BYTES) return SYMBOL_ERROR;
  return null;
}

// Form -> { ok, errors: { field: message }, params }. A value out of bounds gets the
// contract's own message; text that is no number gets a page message.
export function validateForm(form, creator) {
  const errors = {};
  const p = {
    total_supply: TOTAL_SUPPLY.toString(),
    creator: String(creator ?? ''),
  };
  const name = String(form.name ?? '').trim();
  const symbol = String(form.symbol ?? '').trim();
  if (!name) errors.name = 'Enter a name.';
  else if (bytesOf(name) > NAME_MAX_BYTES) errors.name = NAME_ERROR;
  if (!symbol) errors.symbol = 'Enter a symbol.';
  else if (bytesOf(symbol) > SYMBOL_MAX_BYTES) errors.symbol = SYMBOL_ERROR;

  const bounded = (key, param, read) => {
    let value;
    try {
      value = read();
    } catch (e) {
      errors[key] = e.message;
      return null;
    }
    const b = BOUNDS[param];
    if (value < b.min || value > b.max) {
      errors[key] = b.error;
      return null;
    }
    return value;
  };
  const alloc = bounded('creatorPct', 'creator_alloc_bps', () => pctToBps(form.creatorPct));
  const virt = bounded('virtualNear', 'virtual_near', () => {
    try {
      return parseDecimal(String(form.virtualNear ?? '').trim(), 24);
    } catch {
      throw new Error(FORMAT_NUMBER);
    }
  });
  const ns = (key, param) => bounded(key, param, () => durationSeconds(form[key]) * SEC_NS);
  const loud = ns('loudWindow', 'loud_window_ns');
  const notice = ns('notice', 'notice_ns');
  const exit = ns('exitWindow', 'exit_window_ns');
  const cap = bounded('capPct', 'cap_bps', () => pctToBps(form.capPct));
  const capWindow = ns('capWindow', 'cap_window_ns');

  if (Object.keys(errors).length) return { ok: false, errors, params: null };
  // Types as the contract takes them: u16 as JSON numbers, U128/U64 as decimal strings.
  Object.assign(p, {
    creator_alloc_bps: Number(alloc),
    virtual_near: virt.toString(),
    loud_window_ns: loud.toString(),
    notice_ns: notice.toString(),
    exit_window_ns: exit.toString(),
    cap_bps: Number(cap),
    cap_window_ns: capWindow.toString(),
    name,
    symbol,
    icon: null,
  });
  const last = contractCheck(p);
  if (last) return { ok: false, errors: { form: last }, params: null };
  return { ok: true, errors: {}, params: p };
}

// The preset whose values the form holds, or null.
export function matchingPreset(form) {
  const norm = (f) => {
    try {
      return JSON.stringify([
        pctToBps(f.creatorPct).toString(), parseDecimal(String(f.virtualNear).trim(), 24).toString(),
        durationSeconds(f.loudWindow).toString(), durationSeconds(f.notice).toString(), durationSeconds(f.exitWindow).toString(),
        pctToBps(f.capPct).toString(), durationSeconds(f.capWindow).toString(),
      ]);
    } catch {
      return null;
    }
  };
  const mine = norm(form);
  if (!mine) return null;
  return Object.keys(PRESETS).find((k) => norm(presetForm(k)) === mine) ?? null;
}

// Plain-language summary of the parameters.
export function paramsSummary(params) {
  const sec = (k) => BigInt(params[k]) / SEC_NS;
  const pct = (bps) => `${(Number(bps) / 100).toString()}%`;
  return [
    `${params.name} (${params.symbol}), 1,000,000,000 tokens`,
    `creator allocation ${pct(params.creator_alloc_bps)}, loud`,
    `virtual reserve ${fmtNear(params.virtual_near, 2).replace(/\.00$/, '')} NEAR`,
    `buys in the first ${fmtSeconds(sec('loud_window_ns'))} are loud`,
    `notice ${fmtSeconds(sec('notice_ns'))}, exit window ${fmtSeconds(sec('exit_window_ns'))}`,
    `cap ${pct(params.cap_bps)} of supply per ${fmtSeconds(sec('cap_window_ns'))}`,
  ];
}

// ---------------------------------------------------------------------------------------
// Account id, deposit, actions
// ---------------------------------------------------------------------------------------

const NAMED_ACCOUNT = /^(?:[a-z0-9]+[-_])*[a-z0-9]+(?:\.(?:[a-z0-9]+[-_])*[a-z0-9]+)*$/;
export const isNamedAccount = (id) => typeof id === 'string' && id.length >= 2 && id.length <= 64 && NAMED_ACCOUNT.test(id)
  && !/^[0-9a-f]{64}$/.test(id) && !/^0x[0-9a-f]{40}$/.test(id);

// Label of the token account from the symbol: lowercase a-z0-9, at most 12 characters.
export function tokenLabel(symbol) {
  const s = String(symbol ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return (s || 'loud').slice(0, 12);
}

export function randomSuffix(random = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  const A = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return [...random(4)].map((b) => A[b % 36]).join('');
}

// `<label>-<suffix>.<wallet>`, within NEAR's 64 characters.
export function tokenAccountId(symbol, walletId, suffix) {
  if (!isNamedAccount(walletId)) throw new Error(`${walletId} is not a named NEAR account, so it cannot hold a sub-account.`);
  if (!/^[a-z0-9]{1,8}$/.test(suffix)) throw new Error('bad suffix');
  const tail = `-${suffix}.${walletId}`;
  const room = 64 - tail.length;
  if (room < 1) throw new Error(`${walletId} is too long to hold a sub-account: a NEAR account id has 64 characters at most.`);
  return tokenLabel(symbol).slice(0, room) + tail;
}

export function launchCost(wasmBytes) {
  const code = BigInt(wasmBytes) * STORAGE_PER_BYTE;
  const deposit = code + STATE_MARGIN;
  return { bytes: Number(wasmBytes), code, margin: STATE_MARGIN, deposit, fees: FEE_RESERVE, total: deposit + FEE_RESERVE };
}

// Action makers of the chain module, with the same shapes written out for a chain
// module that lacks one.
function makers(chain) {
  return {
    createAccount: chain.createAccount ?? (() => ({ type: 'CreateAccount' })),
    transfer: chain.transfer ?? ((deposit) => ({ type: 'Transfer', deposit })),
    deployContract: chain.deployContract ?? ((code) => ({ type: 'DeployContract', code })),
    functionCall: chain.functionCall ?? ((method, args, gas, deposit = 0n) => ({ type: 'FunctionCall', method, args, gas, deposit })),
  };
}

// The four actions of a launch. No AddKey.
export function launchActions(chain, { wasm, params, deposit }) {
  const m = makers(chain);
  return [m.createAccount(), m.transfer(BigInt(deposit)), m.deployContract(wasm), m.functionCall('new', params, NEW_GAS, 0n)];
}

export async function sendLaunch(chain, { wallet, tokenId, wasm, params, deposit, confirmMs = CONFIRM_MS }) {
  return chain.sendActions(wallet, tokenId, launchActions(chain, { wasm, params, deposit }), { confirmMs });
}

// sendActions result -> { kind, code, message }
//   success | rejected (executed and failed: the contract or the protocol refused) |
//   funds (not enough NEAR) | refused (a node refused it, nothing ran) | unknown
export function classifyLaunch(res) {
  if (!res) return { kind: 'unknown', code: null, message: 'No result.' };
  const text = String(res.errorMessage ?? '');
  const kindName = (text.match(/"kind":\{"([A-Za-z]+)"/) ?? text.match(/\b(AccountAlreadyExists|LackBalanceForState|NotEnoughBalance|CreateAccountNotAllowed)\b/) ?? [])[1] ?? null;
  const poor = /NotEnoughBalance|LackBalanceForState|not enough balance|InsufficientBalance/i.test(text);
  if (res.ok) return { kind: 'success', code: null, message: '' };
  if (res.outcome === 'unknown') return { kind: 'unknown', code: null, message: text };
  if (poor) return { kind: 'funds', code: res.errorCode ?? kindName, message: text };
  if (res.outcome === 'failure') return { kind: 'rejected', code: res.errorCode ?? kindName, message: text };
  return { kind: 'refused', code: res.errorCode ?? kindName, message: text };
}

// ---------------------------------------------------------------------------------------
// Checks from chain
// ---------------------------------------------------------------------------------------

export const PARAM_KEYS = Object.freeze(['total_supply', 'creator', 'creator_alloc_bps', 'virtual_near', 'loud_window_ns',
  'notice_ns', 'exit_window_ns', 'cap_bps', 'cap_window_ns']);

// What differs between the parameters asked for and get_params + ft_metadata.
export function paramMismatches(intended, onchain, meta = null) {
  const o = onchain && typeof onchain === 'object' ? onchain : {};
  const out = [];
  for (const k of PARAM_KEYS) {
    if (o[k] === undefined || o[k] === null || String(o[k]) !== String(intended[k])) out.push(`${k}: asked ${intended[k]}, on chain ${o[k]}`);
  }
  const dec = (v) => ((typeof v === 'string' || typeof v === 'number') && /^\d+$/.test(String(v)) ? BigInt(v) : null);
  const capUnits = (BigInt(intended.total_supply) * BigInt(intended.cap_bps)) / 10000n;
  if (dec(o.cap_units) !== capUnits) out.push(`cap_units: expected ${capUnits}, on chain ${o.cap_units}`);
  const launch = dec(o.launch_ts);
  const until = dec(o.loud_until);
  if (launch === null || until === null || until !== launch + BigInt(intended.loud_window_ns)) out.push('loud_until is not launch_ts + loud_window_ns');
  if (meta !== null) {
    if (!meta || meta.name !== intended.name) out.push(`name: asked ${intended.name}, on chain ${meta?.name}`);
    if (!meta || meta.symbol !== intended.symbol) out.push(`symbol: asked ${intended.symbol}, on chain ${meta?.symbol}`);
  }
  return out;
}

const queryOf = (request_type, account_id) => ({ request_type, account_id, finality: 'final' });

// One read of everything the checks need. A read that fails is null.
export async function readToken(chain, tokenId) {
  const soft = (p) => p.catch(() => null);
  const [account, keyList, params, meta] = await Promise.all([
    soft(chain.rpc('query', queryOf('view_account', tokenId))),
    soft(chain.rpc('query', queryOf('view_access_key_list', tokenId))),
    soft(chain.view(tokenId, 'get_params')),
    soft(chain.view(tokenId, 'ft_metadata')),
  ]);
  return { account, keys: keyList && Array.isArray(keyList.keys) ? keyList.keys : null, params, meta };
}

// The four checks. `read` is what readToken returned.
export function launchChecks(read, intended, codeHash) {
  const { account, keys, params, meta } = read ?? {};
  const mism = params ? paramMismatches(intended, params, meta ?? undefined) : null;
  return [
    {
      id: 'exists',
      ok: !!account,
      label: 'The token account exists',
      detail: account ? `${fmtNear(account.amount ?? '0', 4)} NEAR on it` : 'not found on NEAR testnet',
    },
    {
      id: 'keys',
      ok: Array.isArray(keys) && keys.length === 0,
      label: 'It has no access key',
      detail: Array.isArray(keys) ? `view_access_key_list: ${keys.length} ${keys.length === 1 ? 'key' : 'keys'}` : 'the key list could not be read',
    },
    {
      id: 'params',
      ok: Array.isArray(mism) && mism.length === 0 && !!meta,
      label: 'get_params and ft_metadata equal what you asked',
      detail: !params ? 'get_params could not be read' : !meta ? 'ft_metadata could not be read' : mism.length ? mism.join('; ').slice(0, 400) : 'all nine parameters, the name and the symbol',
    },
    {
      id: 'code',
      ok: !!account && account.code_hash === codeHash,
      label: 'Its code hash equals the published wasm',
      detail: account ? `${account.code_hash}${account.code_hash === codeHash ? '' : `, expected ${codeHash}`}` : 'no account',
    },
  ];
}

// Reads until every check passes or the tries run out (final reads lag a few seconds).
export async function verifyLaunch(chain, tokenId, intended, codeHash, { tries = 10, waitMs = 2000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let checks = null;
  for (let i = 0; i < tries; i++) {
    checks = launchChecks(await readToken(chain, tokenId), intended, codeHash);
    if (checks.every((c) => c.ok)) break;
    if (i < tries - 1) await sleep(waitMs);
  }
  return { ok: checks.every((c) => c.ok), checks };
}

// ---------------------------------------------------------------------------------------
// Wasm, wallets, launches kept in this browser
// ---------------------------------------------------------------------------------------

const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

// Bytes + web/loud.wasm.json -> { ok, sha256Hex, codeHash, message }
export async function checkWasm(chain, bytes, meta) {
  const digest = await chain.sha256(bytes);
  const sha256Hex = hex(digest);
  const codeHash = chain.base58Encode(digest);
  if (!meta || meta.sha256_hex !== sha256Hex || meta.code_hash_base58 !== codeHash || Number(meta.bytes) !== bytes.length) {
    return { ok: false, sha256Hex, codeHash, message: 'The contract file does not match its record (loud.wasm.json). Reload the page.' };
  }
  return { ok: true, sha256Hex, codeHash, message: '' };
}

const cleanWallet = (w) => (w && typeof w === 'object' && typeof w.accountId === 'string' && /^[a-z0-9._-]{2,64}$/.test(w.accountId)
  && typeof w.publicKey === 'string' && w.publicKey.length > 0 && w.publicKey.length < 400
  && typeof w.secretKey === 'string' && w.secretKey.length > 0 && w.secretKey.length < 400
  ? { accountId: w.accountId, publicKey: w.publicKey, secretKey: w.secretKey } : null);

// The main page's store: { wallets: up to two, active: index }.
export function parseWallets(text) {
  const empty = { wallets: [], active: 0 };
  if (typeof text !== 'string' || !text) return empty;
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return empty;
  }
  if (!raw || !Array.isArray(raw.wallets)) return empty;
  const wallets = raw.wallets.map(cleanWallet).filter(Boolean).slice(0, 2);
  const active = Number.isInteger(raw.active) && raw.active >= 0 && raw.active < wallets.length ? raw.active : 0;
  return { wallets, active };
}

export const serializeWallets = (store) => JSON.stringify({ wallets: store.wallets.map(cleanWallet).filter(Boolean).slice(0, 2), active: store.active });

export function addWallet(store, wallet) {
  const wallets = [...store.wallets.filter((w) => w.accountId !== wallet.accountId), cleanWallet(wallet)].filter(Boolean).slice(-2);
  return { wallets, active: wallets.length - 1 };
}

const STATUSES = new Set(['sent', 'ok', 'checks', 'failed', 'unknown']);
const cleanLaunch = (r) => (r && typeof r === 'object' && isNamedAccount(r.token)
  ? {
    token: r.token,
    name: String(r.name ?? '').slice(0, 64),
    symbol: String(r.symbol ?? '').slice(0, 16),
    tx: typeof r.tx === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,50}$/.test(r.tx) ? r.tx : null,
    at: typeof r.at === 'string' ? r.at.slice(0, 30) : null,
    status: STATUSES.has(r.status) ? r.status : 'sent',
  } : null);

export function parseLaunches(text) {
  try {
    const raw = JSON.parse(text);
    return Array.isArray(raw) ? raw.map(cleanLaunch).filter(Boolean).slice(0, MAX_LAUNCHES) : [];
  } catch {
    return [];
  }
}

// Newest first; a record for the same token replaces the old one.
export function upsertLaunch(list, rec) {
  const c = cleanLaunch(rec);
  if (!c) return list;
  return [c, ...list.filter((r) => r.token !== c.token)].slice(0, MAX_LAUNCHES);
}

export const STATUS_TEXT = Object.freeze({
  sent: 'sent, not confirmed',
  ok: 'launched, all checks passed',
  checks: 'launched, a check did not pass',
  failed: 'not launched',
  unknown: 'sent, outcome unknown',
});

// ---------------------------------------------------------------------------------------
// Result wording
// ---------------------------------------------------------------------------------------

export const openHref = (token) => `index.html?token=${encodeURIComponent(token)}#try`;

export function costView(cost, balanceYocto) {
  const bal = balanceYocto === null || balanceYocto === undefined ? null : BigInt(balanceYocto);
  return {
    enough: bal === null ? null : bal >= cost.total,
    rows: [
      ['Contract code', `${cost.bytes.toLocaleString('en-US')} bytes × 0.00001 NEAR = ${fmtNear(cost.code, 5)} NEAR`],
      ['State margin', `${fmtNear(cost.margin, 2)} NEAR`],
      ['Deposit to the token account', `${fmtNear(cost.deposit, 5)} NEAR`],
      ['Gas allowance', `up to ${fmtNear(cost.fees, 2)} NEAR`],
      ['Launch needs', `${fmtNear(cost.total, 5)} NEAR`],
      ['Wallet balance', bal === null ? 'no wallet yet' : `${fmtNear(bal, 4)} NEAR${bal >= cost.total ? '' : ', not enough'}`],
    ],
  };
}

// What the result block says. ctx: { tokenId, symbol, hash, explorerUrl, checks, cls, faucet }
export function resultView(ctx) {
  const { cls, tokenId, checks } = ctx;
  const allOk = Array.isArray(checks) && checks.length > 0 && checks.every((c) => c.ok);
  if (cls.kind === 'success' || (cls.kind === 'unknown' && checks && checks.find((c) => c.id === 'code')?.ok)) {
    return {
      tone: allOk ? 'ok' : 'unknown',
      call: cls.kind === 'success' ? 'Launched' : 'Launched (found on chain after the wait)',
      message: allOk
        ? `${ctx.symbol} is live as ${tokenId}. All four checks passed on NEAR testnet.`
        : `${ctx.symbol} was deployed as ${tokenId}, but a check below did not pass.`,
      token: tokenId,
      open: openHref(tokenId),
      status: allOk ? 'ok' : 'checks',
    };
  }
  if (cls.kind === 'unknown') {
    return {
      tone: 'unknown',
      call: 'Sent, outcome unknown',
      message: `The launch transaction was sent, but no node returned its outcome in time and ${tokenId} is not on chain yet. It may still execute. Open the transaction, and check this list again later; the page does not send it twice.`,
      token: tokenId,
      open: null,
      status: 'unknown',
    };
  }
  if (cls.kind === 'funds') {
    return {
      tone: 'fail', call: 'Not enough NEAR',
      message: `The wallet cannot pay the deposit and gas. ${cls.message ? cls.message.slice(0, 240) : ''}`.trim(),
      token: null, open: null, status: 'failed',
    };
  }
  if (cls.kind === 'rejected') {
    return {
      tone: 'fail',
      call: `Rejected${cls.code ? `: ${cls.code}` : ''}`,
      message: `${cls.message.slice(0, 400)} Nothing was created: the whole transaction is undone and the deposit comes back, less gas.`,
      token: null, open: null, status: 'failed',
    };
  }
  return {
    tone: 'fail', call: `Refused by the node${cls.code ? `: ${cls.code}` : ''}`,
    message: `${cls.message.slice(0, 400)} Nothing ran.`,
    token: null, open: null, status: 'failed',
  };
}

// ---------------------------------------------------------------------------------------
// Mock chain for ?mock=1 and tests: no network, invented hashes
// ---------------------------------------------------------------------------------------

export function createLaunchMock({ faucetFails = false, reject = null, unknown = false, startNear = 10n, delayMs = 0 } = {}) {
  const accounts = new Map(); // id -> { amount, code_hash, keys, params, meta }
  let seq = 0;
  const wait = () => new Promise((r) => setTimeout(r, delayMs));
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const fakeHash = () => {
    seq += 1;
    let s = '';
    for (let i = 0; i < 44; i++) s += B58[(seq * 31 + i * 17 + (i * i) % 13) % 58];
    return s;
  };
  class FaucetError extends Error {}
  const unknownAccount = () => Object.assign(new Error('UNKNOWN_ACCOUNT'), { cause_: 'UNKNOWN_ACCOUNT' });
  const mock = {
    isMock: true,
    sent: [],
    accounts,
    FaucetError,
    sha256: realChain.sha256,
    base58Encode: realChain.base58Encode,
    deployContract: realChain.deployContract,
    async accountState(id) {
      const a = accounts.get(id);
      return a ? { exists: true, amountYocto: a.amount.toString() } : { exists: false, amountYocto: '0' };
    },
    async createTestWallet({ prefix = 'loud-try' } = {}) {
      await wait();
      if (faucetFails) throw new FaucetError('the testnet faucet refused to create the account: faucet.example: HTTP 429 {"error":"Too many requests from this IP, retry in 12 hours"}');
      seq += 1;
      const accountId = `${prefix}-mock${seq.toString(36)}.testnet`;
      accounts.set(accountId, { amount: startNear * NEAR, code_hash: '11111111111111111111111111111111', keys: [{ public_key: `ed25519:mock${seq}` }] });
      return { accountId, publicKey: `ed25519:mock${seq}`, secretKey: `mock-secret-${seq}` };
    },
    async rpc(method, params) {
      const a = accounts.get(params.account_id);
      if (!a) throw unknownAccount();
      if (params.request_type === 'view_account') return { amount: a.amount.toString(), code_hash: a.code_hash, storage_usage: 1000 };
      if (params.request_type === 'view_access_key_list') return { keys: a.keys };
      throw new Error(`mock rpc: ${method} ${params.request_type}`);
    },
    async view(id, method) {
      const a = accounts.get(id);
      if (!a || !a.params) throw new Error(`view ${method}: no contract`);
      if (method === 'get_params') return a.params;
      if (method === 'ft_metadata') return a.meta;
      throw new Error(`mock view ${method}`);
    },
    async sendActions(wallet, receiverId, actions) {
      await wait();
      mock.sent.push({ wallet: wallet.accountId, receiverId, actions });
      const hash = fakeHash();
      const base = { hash, value: null, logs: [], events: [], settled: true, explorerUrl: null, signedHashes: [hash] };
      const payer = accounts.get(wallet.accountId);
      const deposit = actions.filter((x) => x.type === 'Transfer').reduce((s, x) => s + BigInt(x.deposit), 0n);
      if (!payer || payer.amount < deposit + FEE_RESERVE / 5n) {
        return { ...base, ok: false, outcome: 'invalid', hash: null, errorCode: null, errorMessage: `{"InvalidTxError":{"NotEnoughBalance":{"signer_id":"${wallet.accountId}"}}}` };
      }
      if (unknown) return { ...base, ok: false, outcome: 'unknown', errorCode: null, errorMessage: `The transaction was sent, but no node returned its final outcome within ${CONFIRM_MS / 1000} s` };
      const types = actions.map((x) => x.type).join(',');
      const init = actions.find((x) => x.type === 'FunctionCall');
      const code = actions.find((x) => x.type === 'DeployContract')?.code;
      const panic = reject ?? (init ? contractCheck(init.args, receiverId) : 'no init');
      if (types !== 'CreateAccount,Transfer,DeployContract,FunctionCall' || accounts.has(receiverId) || panic) {
        // chain.js gives the panic text without the "Smart contract panicked:" prefix.
        const msg = panic || (accounts.has(receiverId) ? `{"ActionError":{"index":0,"kind":{"AccountAlreadyExists":{"account_id":"${receiverId}"}}}}` : `bad actions ${types}`);
        payer.amount -= FEE_RESERVE / 10n;
        return { ...base, ok: false, outcome: 'failure', errorCode: (msg.match(/\bE_[A-Z_]+\b/) ?? [null])[0], errorMessage: msg };
      }
      payer.amount -= deposit + FEE_RESERVE / 5n;
      const launchNs = BigInt(Date.now()) * 1_000_000n;
      const a = init.args;
      accounts.set(receiverId, {
        amount: deposit,
        code_hash: realChain.base58Encode(await realChain.sha256(code)),
        keys: [],
        params: {
          ...Object.fromEntries(PARAM_KEYS.map((k) => [k, a[k]])),
          launch_ts: launchNs.toString(),
          loud_until: (launchNs + BigInt(a.loud_window_ns)).toString(),
          cap_units: ((BigInt(a.total_supply) * BigInt(a.cap_bps)) / 10000n).toString(),
          creator_alloc: ((BigInt(a.total_supply) * BigInt(a.creator_alloc_bps)) / 10000n).toString(),
        },
        meta: { spec: 'ft-1.0.0', name: a.name, symbol: a.symbol, icon: null, decimals: 18 },
      });
      return { ...base, ok: true, outcome: 'success', errorCode: null, errorMessage: null };
    },
  };
  return mock;
}

// Stand-in for web/loud.wasm in mock mode: the published file's size, invented bytes.
export async function mockWasm(chain, bytes = 238_218) {
  const wasm = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) wasm[i] = (i * 131 + 7) & 0xff;
  const digest = await chain.sha256(wasm);
  return { wasm, meta: { sha256_hex: hex(digest), code_hash_base58: chain.base58Encode(digest), bytes, commit: 'mock' } };
}

// ---------------------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------------------

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

function safeStorage(store) {
  return {
    get(k) {
      try {
        return store.getItem(k);
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        store.setItem(k, v);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export async function startPage(doc = document, win = window) {
  const $ = (s) => doc.querySelector(s);
  const el = (tag, attrs = {}, ...kids) => {
    const n = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined) continue;
      if (k === 'text') n.textContent = v;
      else if (k === 'class') n.className = v;
      else n.setAttribute(k, v);
    }
    for (const kid of kids) if (kid !== null && kid !== undefined) n.append(kid);
    return n;
  };
  const search = new URLSearchParams(win.location.search);
  const isMock = search.get('mock') === '1';
  const chain = isMock
    ? createLaunchMock({
      faucetFails: search.get('faucet') === 'fail',
      reject: search.get('reject') === '1' ? 'E_PARAMS: notice_ns must be 30 s ..= 7 days' : null,
      unknown: search.get('unknown') === '1',
      startNear: search.get('poor') === '1' ? 2n : 10n,
      delayMs: 900,
    })
    : realChain;
  if (isMock) win.loudLaunchMock = chain;
  const storage = safeStorage(isMock ? memoryStorage() : win.localStorage);

  const S = {
    wasm: null,
    codeHash: null,
    wasmError: null,
    store: parseWallets(storage.get(WALLET_KEY)),
    balance: null,
    busy: false,
    launches: parseLaunches(storage.get(LAUNCHES_KEY) ?? '[]'),
    suffix: randomSuffix(),
  };
  const wallet = () => S.store.wallets[S.store.active] ?? null;

  if (isMock) {
    const b = $('#l-mock');
    b.textContent = MOCK_BANNER;
    b.hidden = false;
  }

  // Form
  const form = $('#launch-form');
  const readForm = () => {
    const v = (id) => $(`#${id}`).value;
    const d = (id) => [v(id), v(`${id}-unit`)];
    return {
      name: v('f-name'), symbol: v('f-symbol'), creatorPct: v('f-creator'), virtualNear: v('f-virtual'),
      loudWindow: d('f-loud'), notice: d('f-notice'), exitWindow: d('f-exit'), capPct: v('f-cap'), capWindow: d('f-capwin'),
    };
  };
  const ids = { name: 'f-name', symbol: 'f-symbol', creatorPct: 'f-creator', virtualNear: 'f-virtual', loudWindow: 'f-loud', notice: 'f-notice', exitWindow: 'f-exit', capPct: 'f-cap', capWindow: 'f-capwin' };
  const writeForm = (f) => {
    for (const [key, id] of Object.entries(ids)) {
      const val = f[key];
      if (Array.isArray(val)) {
        $(`#${id}`).value = val[0];
        $(`#${id}-unit`).value = val[1];
      } else {
        $(`#${id}`).value = val;
      }
    }
  };
  writeForm(presetForm(DEFAULT_PRESET));

  const tokenIdNow = () => {
    const w = wallet();
    if (!w) return { id: null, error: null };
    try {
      return { id: tokenAccountId($('#f-symbol').value, w.accountId, S.suffix), error: null };
    } catch (e) {
      return { id: null, error: e.message };
    }
  };

  function render() {
    const f = readForm();
    const w = wallet();
    const v = validateForm(f, w ? w.accountId : 'creator.testnet');
    for (const [key, id] of Object.entries(ids)) {
      const err = v.errors[key] ?? '';
      const box = $(`#${id}-err`);
      box.textContent = err;
      box.hidden = !err;
      $(`#${id}`).setAttribute('aria-invalid', err ? 'true' : 'false');
    }
    const formErr = $('#l-form-err');
    formErr.textContent = v.errors.form ?? '';
    formErr.hidden = !v.errors.form;

    const preset = matchingPreset(f);
    for (const b of doc.querySelectorAll('[data-preset]')) b.setAttribute('aria-pressed', String(b.dataset.preset === preset));
    $('#l-preset-note').textContent = preset ? PRESETS[preset].note : 'Your own values. Each is checked against the contract\'s bounds as you type.';

    // Wallet
    $('#l-wallet-none').hidden = !!w;
    $('#l-wallet-have').hidden = !w;
    $('#l-switch').hidden = S.store.wallets.length < 2;
    if (w) {
      const a = $('#l-wallet-id');
      a.textContent = w.accountId;
      a.href = isMock ? '#' : realChain.accountUrl(w.accountId);
      $('#l-wallet-label').textContent = S.store.active === 0 ? 'Wallet A' : 'Wallet B';
      $('#l-wallet-near').textContent = S.balance === null ? 'reading…' : `${fmtNear(S.balance, 4)} NEAR`;
    }

    // Token account and cost
    const t = tokenIdNow();
    $('#l-token-id').textContent = t.id ?? (t.error ?? 'get a wallet first');
    const cost = S.wasm ? launchCost(S.wasm.length) : null;
    const facts = $('#l-cost');
    facts.replaceChildren();
    if (cost) {
      const cv = costView(cost, w ? S.balance : null);
      for (const [k, val] of cv.rows) facts.append(el('div', {}, el('dt', { text: k }), el('dd', { text: val })));
      const short = $('#l-short');
      short.hidden = !(w && cv.enough === false);
      short.textContent = cv.enough === false ? `Not enough NEAR: the launch needs ${fmtNear(cost.total, 4)} NEAR and the wallet holds ${fmtNear(S.balance ?? 0n, 4)}. A new test wallet from the faucet holds 10 NEAR.` : '';
    }
    const reason = S.wasmError ? S.wasmError
      : !S.wasm ? 'Loading the contract file…'
        : !w ? 'Get a test wallet first.'
          : t.error ? t.error
            : !v.ok ? 'Fix the fields marked above.'
              : S.balance === null ? 'Reading the wallet balance…'
                : S.balance < cost.total ? 'Not enough NEAR in the wallet.'
                  : '';
    const btn = $('#l-launch');
    btn.disabled = S.busy || !!reason;
    $('#l-why').textContent = S.busy ? '' : reason;
    $('#l-why').hidden = S.busy || !reason;
    renderLaunches();
    return v;
  }

  function renderLaunches() {
    const list = $('#l-list');
    list.replaceChildren();
    $('#l-list-empty').hidden = S.launches.length > 0;
    for (const r of S.launches) {
      const live = r.status === 'ok' || r.status === 'checks';
      list.append(el('li', { 'data-status': r.status },
        el('span', { class: 'l-sym', text: r.symbol || '?' }),
        el('span', { class: 'l-acct' }, isMock ? doc.createTextNode(r.token) : el('a', { href: realChain.accountUrl(r.token), text: r.token })),
        el('span', { class: 'l-st', text: STATUS_TEXT[r.status] ?? r.status }),
        el('span', { class: 'l-go' }, live || r.status === 'unknown' || r.status === 'sent' ? el('a', { href: openHref(r.token), text: 'Open' }) : null)));
    }
  }

  const saveLaunch = (rec) => {
    S.launches = upsertLaunch(S.launches, rec);
    storage.set(LAUNCHES_KEY, JSON.stringify(S.launches));
  };

  async function readBalance() {
    const w = wallet();
    if (!w) return;
    try {
      const st = await chain.accountState(w.accountId);
      S.balance = BigInt(st.amountYocto);
    } catch {
      S.balance = null;
      $('#l-wallet-near').textContent = 'could not read the balance';
    }
    render();
  }

  // Result block
  const result = $('#l-result');
  function showResult(view, ctx = {}) {
    result.dataset.ok = view.tone === 'ok' ? 'true' : view.tone === 'fail' ? 'false' : 'unknown';
    const kids = [el('p', { class: 'call', text: view.call }), el('p', { class: 'msg', text: view.message })];
    if (view.token) {
      kids.push(el('dl', { class: 'facts l-made' },
        el('div', {}, el('dt', { text: 'Token account' }), el('dd', {}, isMock ? doc.createTextNode(view.token) : el('a', { href: realChain.accountUrl(view.token), text: view.token }))),
        ctx.hash ? el('div', {}, el('dt', { text: 'Launch transaction' }), el('dd', {}, isMock ? doc.createTextNode(`${ctx.hash} (mock, no explorer link)`) : el('a', { href: realChain.txUrl(ctx.hash), text: ctx.hash }))) : null));
    } else if (ctx.hash && !isMock) {
      kids.push(el('p', { class: 'hint' }, el('a', { href: realChain.txUrl(ctx.hash), text: `Transaction ${ctx.hash}` })));
    }
    if (Array.isArray(ctx.checks)) {
      kids.push(el('ul', { class: 'l-checks', 'aria-label': 'Checks read from NEAR testnet' },
        ...ctx.checks.map((c) => el('li', { 'data-ok': String(c.ok) }, el('b', { text: c.ok ? 'PASS' : 'FAIL' }), ` ${c.label}. `, el('span', { class: 'fine', text: c.detail })))));
    }
    if (view.open) {
      const abs = new URL(view.open, win.location.href).href;
      const copy = el('button', { type: 'button', class: 'link', id: 'l-copy', text: 'Copy link' });
      copy.addEventListener('click', async () => {
        try {
          await win.navigator.clipboard.writeText(abs);
          copy.textContent = 'Copied';
        } catch {
          copy.textContent = abs;
        }
      });
      kids.push(el('p', { class: 'l-open-row' }, el('a', { class: 'l-open', href: view.open, text: 'Open your token' }), ' ', copy));
      kids.push(el('p', { class: 'hint', text: 'The main page opens on your token: buy in the launch window and your tokens are loud; buy after it and they are quiet.' }));
    }
    result.replaceChildren(...kids);
    result.hidden = false;
  }

  // Wallet buttons
  $('#l-new').addEventListener('click', async () => {
    if (S.busy) return;
    S.busy = true;
    const pend = $('#l-pending');
    pend.textContent = 'Asking the testnet faucet for a wallet…';
    pend.hidden = false;
    render();
    try {
      const w = await chain.createTestWallet({ prefix: 'loud-try' });
      S.store = addWallet(S.store, w);
      storage.set(WALLET_KEY, serializeWallets(S.store));
      S.balance = null;
      showResult({ tone: 'ok', call: 'Test wallet ready', message: `${w.accountId} was created and funded by the testnet faucet. Its key stays in this browser; the main page uses the same wallet.` });
    } catch (e) {
      showResult({ tone: 'fail', call: 'The faucet did not create a wallet', message: `${String(e?.message ?? e).slice(0, 400)} ${FAUCET_LIMIT}` });
    } finally {
      S.busy = false;
      pend.hidden = true;
    }
    render();
    await readBalance();
  });
  $('#l-switch').addEventListener('click', async () => {
    S.store = { ...S.store, active: S.store.active === 0 ? 1 : 0 };
    storage.set(WALLET_KEY, serializeWallets(S.store));
    S.balance = null;
    render();
    await readBalance();
  });
  for (const b of doc.querySelectorAll('[data-preset]')) {
    b.addEventListener('click', () => {
      writeForm(presetForm(b.dataset.preset, { name: $('#f-name').value, symbol: $('#f-symbol').value }));
      render();
    });
  }
  form.addEventListener('input', () => render());
  form.addEventListener('change', () => render());

  // Launch
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = render();
    const w = wallet();
    const t = tokenIdNow();
    if (S.busy || !v.ok || !w || !t.id || !S.wasm) return;
    S.busy = true;
    const pend = $('#l-pending');
    const started = Date.now();
    const kb = Math.round(S.wasm.length / 1000);
    const tick = () => {
      pend.textContent = `Waiting for NEAR testnet… ${Math.round((Date.now() - started) / 1000)} s. The deploy carries about ${kb} KB and can take 10 s or more.`;
    };
    tick();
    const timer = win.setInterval(tick, 1000);
    pend.hidden = false;
    result.hidden = true;
    render();
    const tokenId = t.id;
    const params = v.params;
    // Kept before sending, so that a launch whose outcome is unknown is not lost.
    saveLaunch({ token: tokenId, name: params.name, symbol: params.symbol, tx: null, at: new Date().toISOString(), status: 'sent' });
    let res = null;
    try {
      res = await sendLaunch(chain, { wallet: w, tokenId, wasm: S.wasm, params, deposit: launchCost(S.wasm.length).deposit });
    } catch (err) {
      res = { ok: false, outcome: 'invalid', hash: null, errorCode: null, errorMessage: `Nothing was sent: ${String(err?.message ?? err).slice(0, 300)}` };
    }
    const cls = classifyLaunch(res);
    let checks = null;
    if (cls.kind === 'success' || cls.kind === 'unknown') {
      pend.textContent = 'Reading the new token from NEAR testnet…';
      checks = (await verifyLaunch(chain, tokenId, params, S.codeHash, { tries: cls.kind === 'success' ? 10 : 6, waitMs: isMock ? 50 : 2000 })).checks;
    }
    win.clearInterval(timer);
    const view = resultView({ cls, tokenId, symbol: params.symbol, checks });
    const hash = res.hash ?? res.refusedHash ?? null;
    saveLaunch({ token: tokenId, name: params.name, symbol: params.symbol, tx: res.hash ?? null, at: new Date().toISOString(), status: view.status });
    if (view.status !== 'unknown') S.suffix = randomSuffix(); // the next launch gets a new account id
    // Checks are shown once something is on chain; for a launch still unknown they would
    // only say "not found".
    showResult(view, { hash: res.hash ?? (cls.kind === 'refused' ? null : hash), checks: view.status === 'unknown' ? null : checks });
    S.busy = false;
    pend.hidden = true;
    render();
    await readBalance();
  });

  render();
  await readBalance();

  // The contract file
  try {
    let bytes;
    let meta;
    if (isMock) {
      ({ wasm: bytes, meta } = await mockWasm(chain));
    } else {
      const [m, b] = await Promise.all([
        win.fetch('loud.wasm.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)),
        win.fetch('loud.wasm', { cache: 'no-cache' }).then((r) => (r.ok ? r.arrayBuffer() : null)),
      ]);
      if (!m || !b) throw new Error('The contract file is not published on this site yet.');
      meta = m;
      bytes = new Uint8Array(b);
    }
    const chk = await checkWasm(chain, bytes, meta);
    if (!chk.ok) throw new Error(chk.message);
    S.wasm = bytes;
    S.codeHash = chk.codeHash;
    const src = meta.commit && meta.commit !== 'mock' ? ` built from commit ${String(meta.commit).slice(0, 7)}` : '';
    $('#l-wasm').textContent = `Contract: ${bytes.length.toLocaleString('en-US')} bytes${src}, code hash ${chk.codeHash}${isMock ? ' (invented bytes in mock mode)' : ''}.`;
    if (!isMock) {
      const live = await win.fetch('live.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (live && live.code_hash) {
        $('#l-wasm').textContent += live.code_hash === chk.codeHash
          ? ' The same code as the token on the main page.'
          : ` The main page's token runs other code (${live.code_hash}).`;
      }
    }
  } catch (err) {
    S.wasmError = String(err?.message ?? err);
    $('#l-wasm').textContent = S.wasmError;
  }
  render();
}

if (typeof document !== 'undefined' && document.querySelector('#launch-form')) startPage().catch((e) => {
  const s = document.querySelector('#l-wasm');
  if (s) s.textContent = `The page script stopped: ${e.message}`;
});
