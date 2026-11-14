// On-chain proof run for LOUD on NEAR testnet (SPEC section 8 and "No admin" in section 7).
// Runs only in GitHub Actions. Every key is generated in memory and is never written
// to disk or to the log. Output: web/deployment.json and web/receipts.json (see README.md).
//
// Client: near-api-js 5.1.1 is used for keys, actions and borsh encoding only
// (KeyPair, transactions.*, utils.serialize; checked against its typings and the
// @near-js/transactions 1.3.3 sources). RPC calls go through rpc.mjs.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import nearApi from 'near-api-js';
import { createRpc, RpcError, sleep } from './rpc.mjs';
import {
  TGAS, nearToYocto, yoctoToNear, unitsToTokens, presetParams, splitEvenly, budget,
  failureText, errorCode, parseEvents, returnValueBigInt, leaveFilled, evaluateSplit,
  txLink, accountLink, jsonReplacer,
  receiptSettlement, base58Encode, faucetTx, paramMismatches,
  txRecord, needsLookup, leaveCounts, leaveCountsText, unresolvedSummary,
  STORAGE_MIN_YOCTO, buyEvent, evaluateBuy, tokenNear,
  catchEvent, catchDeposit, evaluateCatch, liveDocument,
} from './lib.mjs';

const { KeyPair, transactions: T, utils } = nearApi;
const { base_encode: b58encode, base_decode: b58decode } = utils.serialize;

// Configuration

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const WEB_DIR = path.join(REPO, 'web');
const env = process.env;
const list = (v) => v.split(',').map((s) => s.trim()).filter(Boolean);

// MODE=proof (default): the full run of SPEC section 8 with the demo preset.
// MODE=deploy: only the faucet account and the keyless token deploy, for the token the
// page's live section uses; writes web/live.json and nothing else.
const MODE = env.MODE || 'proof';
const PRESET = env.PRESET || (MODE === 'deploy' ? 'live' : 'demo');
const WASM_PATH = env.LOUD_WASM || path.join(REPO, 'build', 'loud.wasm');
// FastNEAR first: docs.near.org/api/rpc/providers lists the near.org endpoints as
// "severely rate limited", and this run sends several hundred transactions. The near.org
// endpoint stays in the list as a fallback.
const RPC_URLS = list(env.NEAR_RPC_URLS
  || 'https://test.rpc.fastnear.com,https://rpc.testnet.fastnear.com,https://rpc.testnet.near.org,https://near-testnet.drpc.org');
// Testnet account faucet: POST { newAccountId, newAccountPublicKey }. The first URL is the
// one near-cli-rs ships as `faucet_url` for testnet; the second is the same service.
const FAUCET_URLS = list(env.NEAR_FAUCET_URLS
  || 'https://helper.nearprotocol.com/account,https://helper.testnet.near.org/account');
const WALLETS = 20;
const ROUND_MS = Number(env.ROUND_SECONDS || 20) * 1000; // pause between leave rounds
const MAX_RUNTIME_MS = Number(env.MAX_RUNTIME_MINUTES || 24) * 60_000;
const MAX_TX_BYTES = 1_400_000; // below the protocol transaction size limit
const ONE_YOCTO = 1n;

const startedAt = Date.now();
const log = (msg) => console.log(`[${String(Math.round((Date.now() - startedAt) / 1000)).padStart(4)}s] ${msg}`);
const rpc = createRpc({ urls: RPC_URLS, log });

function checkDeadline(what) {
  if (Date.now() - startedAt > MAX_RUNTIME_MS) throw new Error(`runtime limit reached while ${what}`);
}

// Output documents

const deployment = {
  status: 'failed',
  network: 'testnet',
  preset: PRESET,
  token_account: null,
  root_account: null,
  creator_account: null,
  params: null,
  onchain_params: null,
  deployed_at: null,
  deployed_at_ns: null,
  tx: null,
  zero_keys: false,
  access_keys: null,
  wasm: null,
  code_hash: null,
  expected_code_hash: null,
  code_hash_match: null,
  params_match: null,
  param_mismatches: null,
  explorer: { token: null, root: null, tx: null },
  run: {
    repository: env.GITHUB_REPOSITORY || null,
    run_id: env.GITHUB_RUN_ID || null,
    commit: env.GITHUB_SHA || null,
  },
  generated_at: null,
};

const receipts = {
  status: 'failed',
  network: 'testnet',
  token_account: null,
  accounts: { insider: null, late: null, wallets: [] },
  steps: [],
  split: {
    wallets: WALLETS,
    cap_units: null,
    cap_window_ns: null,
    bucket_at_start: null,
    window_start_ns: null,
    window_end_ns: null,
    measured_until_ns: null,
    sold_in_window: null,
    sold_total: null,
    bound: null,
    attempts: 0,
    fills: 0,
    cap_hits: 0,
    receipts_match_counter: null,
    measured_ns: null,
    full_window: null,
    timestamps_valid: null,
    payout_calls: 0,
    payouts_settled: 0,
    fail_reasons: null,
    pass: false,
    // Leave calls by what is known about them (set at the end of step 9).
    executed_failed: null,
    not_executed: null,
    unresolved: null,
  },
  error: null,
  // Transactions the script sent whose outcome stayed unknown (set when the run ends).
  unresolved_txs: null,
  unresolved_hashes: null,
  unresolved_note: null,
  // NEAR of the token account next to the pool's own count, right after the deploy and
  // after step 10, and the unpaid payouts at the end (expected "0").
  token_near: { at_deploy: null, at_end: null },
  owed_total_at_end: null,
  generated_at: null,
};

// Records the faucet returned (the script did not send those transactions) and the leave
// records of step 9 (looked up again inside step 9, before its counts are taken).
const faucetRecs = new WeakSet();
const leaveRecs = new WeakSet();

function addStep(n, title, expect) {
  const step = { n, title, ok: false, expect, got: null, txs: [] };
  receipts.steps.push(step);
  receipts.steps.sort((a, b) => a.n - b.n);
  log(`step ${n}: ${title}`);
  return step;
}

function finishStep(step, ok, got) {
  step.ok = Boolean(ok);
  step.got = got;
  log(`step ${step.n}: ${step.ok ? 'ok' : 'FAILED'} - ${got}`);
}

// Record of a call that pays NEAR when it succeeds (sell, leave). `settled` is true only
// when every receipt outcome of the transaction succeeded and none logged `payout_failed`;
// it is null when the call itself did not succeed, because then nothing was due.
function payRecord(r, extra = {}) {
  const rec = txRecord(r, { ...extra, settled: r.outcome === 'success' ? r.settled === true : null });
  if (r.outcome === 'success' && r.settled !== true) {
    rec.receipt_failures = r.receiptsFailed;
    rec.receipt_error = r.receiptError;
  }
  return rec;
}

async function writeOutputs() {
  const now = new Date().toISOString();
  deployment.generated_at = now;
  receipts.generated_at = now;
  await mkdir(WEB_DIR, { recursive: true });
  await writeFile(path.join(WEB_DIR, 'deployment.json'), JSON.stringify(deployment, jsonReplacer, 2) + '\n');
  await writeFile(path.join(WEB_DIR, 'receipts.json'), JSON.stringify(receipts, jsonReplacer, 2) + '\n');
  log('wrote web/deployment.json and web/receipts.json');
}

// Accounts and transactions

function newSigner(id) {
  const kp = KeyPair.fromRandom('ed25519');
  return { id, kp, pk: kp.getPublicKey().toString(), nonce: null };
}

// A recent final block hash, shared by concurrent senders and refreshed every 30 s.
let recentBlock = { promise: null, at: 0 };
function recentBlockHash() {
  if (!recentBlock.promise || Date.now() - recentBlock.at > 30_000) {
    const promise = rpc.finalBlock().then((b) => b.hash);
    promise.catch(() => {
      if (recentBlock.promise === promise) recentBlock = { promise: null, at: 0 };
    });
    recentBlock = { promise, at: Date.now() };
  }
  return recentBlock.promise;
}

// Nonces are tracked locally per key after one lookup.
async function nextNonce(signer) {
  if (signer.nonce === null) {
    let key = null;
    for (let i = 0; i < 20 && !key; i++) {
      key = await rpc.accessKey(signer.id, signer.pk);
      if (!key) await sleep(1500);
    }
    if (!key) throw new Error(`access key of ${signer.id} is not visible on chain`);
    signer.nonce = BigInt(key.nonce);
  }
  signer.nonce += 1n;
  return signer.nonce;
}

// Sign, send and wait for finality. Never throws for an on-chain or validation failure:
// the result says what happened.
//   outcome: "success" | "failure" (executed and failed) | "invalid" (rejected, not executed) | "unknown"
// A retry after InvalidNonce / Expired signs a new transaction with a new hash. The hash of
// every earlier broadcast is kept in `earlierAttempts` (receipts.json: `earlier_attempts`).
// `hash` is null when the last attempt failed before it was broadcast.
async function sendTx(signer, receiverId, actions) {
  let hash = null;
  const earlierAttempts = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const nonce = await nextNonce(signer);
      const blockHash = await recentBlockHash();
      const tx = T.createTransaction(signer.id, signer.kp.getPublicKey(), receiverId, nonce, actions, b58decode(blockHash));
      const message = tx.encode();
      const digest = new Uint8Array(createHash('sha256').update(message).digest());
      // A NEAR transaction signature is the ed25519 signature of sha256(borsh(tx)).
      const { signature } = signer.kp.sign(digest);
      const signed = new T.SignedTransaction({
        transaction: tx,
        signature: new T.Signature({ keyType: tx.publicKey.keyType, data: signature }),
      });
      const encoded = signed.encode();
      if (encoded.length > MAX_TX_BYTES) throw new Error(`transaction is ${encoded.length} bytes, above ${MAX_TX_BYTES}`);
      hash = b58encode(digest);
      const result = await rpc.sendAndWait({
        signedTxBase64: Buffer.from(encoded).toString('base64'),
        hash,
        senderId: signer.id,
      });
      return { ...summarize(result, hash, signer.id), earlierAttempts };
    } catch (e) {
      const text = e instanceof RpcError ? e.text : String(e?.message ?? e);
      if (e instanceof RpcError && /InvalidNonce|Expired/.test(text) && attempt < 2) {
        // The refused transaction stays on record; the next attempt gets its own hash.
        if (hash) earlierAttempts.push(hash);
        hash = null;
        signer.nonce = null;
        recentBlock = { promise: null, at: 0 };
        continue;
      }
      // Only a transaction the node refused is "invalid"; anything else is not known to have failed.
      const invalid = e instanceof RpcError && (e.cause_ === 'INVALID_TRANSACTION' || e.rpcName === 'REQUEST_VALIDATION_ERROR');
      return {
        hash, account: signer.id, outcome: invalid ? 'invalid' : 'unknown',
        error: text.slice(0, 400), code: errorCode(text), logs: [], successValue: null, blockHash: null,
        settled: false, receiptsFailed: 0, receiptError: null, earlierAttempts,
      };
    }
  }
  throw new Error('unreachable');
}

// One status query by hash (RPC `tx`, wait_until FINAL, through the client's failover).
// -> { found, notSeen, error }: `found` is the summarized final result or null; `notSeen`
// is true when the node answered that it does not know the transaction or did not see it
// become final. Never throws.
async function lookupTx(hash, senderId, tries = 3) {
  try {
    const result = await rpc.call('tx', { tx_hash: hash, sender_account_id: senderId, wait_until: 'FINAL' }, { tries });
    const st = result?.status;
    const final = st !== null && typeof st === 'object' && (typeof st.SuccessValue === 'string' || st.Failure !== undefined);
    if (!final) return { found: null, notSeen: false, error: 'the answer carries no final status' };
    return { found: summarize(result, hash, senderId), notSeen: false, error: null };
  } catch (e) {
    const notSeen = e instanceof RpcError && (e.cause_ === 'UNKNOWN_TRANSACTION' || e.cause_ === 'TIMEOUT_ERROR');
    return { found: null, notSeen, error: String(e?.message ?? e).slice(0, 160) };
  }
}

// Look up every earlier broadcast of a record and write `earlier_attempt_outcomes`.
// An earlier broadcast was refused by a node (InvalidNonce / Expired); it is recorded as
// "invalid" when the lookup does not find it either, with its real outcome when the lookup
// finds it on chain, and as "unknown" when the lookup itself failed. Hashes not reached
// before `until` (wall clock, ms) get no entry and count as unresolved.
// Returns the summarized results of the earlier broadcasts that did execute. Never throws.
async function resolveEarlier(rec, until, tries = 3) {
  const hashes = Array.isArray(rec.earlier_attempts) ? rec.earlier_attempts : [];
  const executed = [];
  if (hashes.length === 0) return executed;
  const outcomes = [];
  for (const h of hashes) {
    if (Date.now() > until) break;
    const look = await lookupTx(h, rec.account, tries);
    if (look.found) {
      outcomes.push({ hash: h, outcome: look.found.outcome, error: look.found.error });
      executed.push(look.found);
      log(`earlier broadcast ${h} of ${rec.hash ?? 'a transaction without a hash'} did execute: ${look.found.outcome}`);
    } else if (look.notSeen) {
      outcomes.push({ hash: h, outcome: 'invalid', error: 'refused at broadcast (InvalidNonce or Expired); one more lookup by hash did not find it' });
    } else {
      outcomes.push({ hash: h, outcome: 'unknown', error: look.error });
    }
  }
  rec.earlier_attempt_outcomes = outcomes;
  return executed;
}

// After the steps: one more lookup for every transaction outside step 9 whose outcome is
// still unknown, and for earlier broadcasts. Only the record changes (outcome, error,
// `resolved_late`); step results stay as they were decided, from chain state read at the
// time. Bounded by wall clock so the job limit is not reached. Never throws.
async function finalLookups() {
  const until = Math.min(Date.now() + 180_000, startedAt + MAX_RUNTIME_MS + 240_000);
  for (const step of receipts.steps) {
    for (const rec of step.txs) {
      if (faucetRecs.has(rec) || leaveRecs.has(rec)) continue;
      try {
        if (needsLookup(rec)) {
          if (Date.now() > until) return;
          const look = await lookupTx(rec.hash, rec.account, 2);
          if (look.found) {
            rec.outcome = look.found.outcome;
            rec.error = look.found.error;
            if ('settled' in rec) rec.settled = look.found.outcome === 'success' ? look.found.settled === true : null;
            rec.resolved_late = true;
            log(`step ${step.n}: ${rec.hash} was confirmed on a later lookup: ${rec.outcome}`);
          } else {
            log(`step ${step.n}: ${rec.hash} is still unconfirmed: ${look.error}`);
          }
        }
        if (Array.isArray(rec.earlier_attempts) && !rec.earlier_attempt_outcomes) {
          if (Date.now() > until) return;
          await resolveEarlier(rec, until, 2);
        }
      } catch (e) {
        log(`step ${step.n}: lookup of ${rec.hash} failed: ${String(e?.message ?? e).slice(0, 160)}`);
      }
    }
  }
}

function summarize(result, hash, account) {
  const receiptsOutcome = result.receipts_outcome ?? [];
  const logs = receiptsOutcome.flatMap((r) => r.outcome?.logs ?? []);
  const failure = result.status?.Failure;
  const error = failure === undefined ? null : failureText(failure);
  const settlement = receiptSettlement(result);
  return {
    hash: result.transaction?.hash ?? hash,
    account,
    outcome: failure === undefined ? 'success' : 'failure',
    error,
    code: errorCode(error),
    logs,
    successValue: typeof result.status?.SuccessValue === 'string' ? result.status.SuccessValue : null,
    blockHash: receiptsOutcome[0]?.block_hash ?? result.transaction_outcome?.block_hash ?? null,
    // All receipt outcomes and their logs, not only the top-level status: a payout that
    // failed shows only there (failed transfer receipt, `payout_failed` event).
    settled: settlement.settled,
    receiptsFailed: settlement.failed.length,
    receiptError: settlement.failed.length > 0
      ? `receipt ${settlement.failed[0].receipt_id ?? '?'} on ${settlement.failed[0].executor ?? '?'}: ${settlement.failed[0].error}`.slice(0, 400)
      : (settlement.receipts === 0 ? 'the result lists no receipt outcomes' : null),
  };
}

// Gas for sell and leave. Their NEAR payout carries the on_payout callback, for which the
// contract reserves 10 Tgas out of the attached gas.
const PAY_GAS = 80n * TGAS;
// Gas for catch: two payouts (the exit owner's NEAR and the refund of the margin), each
// with its own 10 Tgas callback.
const CATCH_GAS = 120n * TGAS;

// One function call. The result carries the method name, which txRecord writes as `call`.
const call = async (signer, contract, method, args, { gas = 30n * TGAS, deposit = 0n } = {}) => ({
  ...await sendTx(signer, contract, [T.functionCall(method, args, gas, deposit)]),
  method,
});

// An amount in yoctoNEAR for a step text.
const nearText = (v) => (v === null || v === undefined ? 'unknown'
  : String(v).startsWith('-') ? `${v} yoctoNEAR` : `${yoctoToNear(v)} NEAR`);

// The storage part of a buy step text, from the result of evaluateBuy.
function buyText(b) {
  const r = b.record;
  return `pool_near rose by ${nearText(r.pool_near_change)} for ${nearText(r.attached)} attached (`
    + (r.registered_before === true
      ? 'the buyer was registered already, so nothing was taken for storage'
      : `the buyer was not registered, so ${nearText(r.expected_storage_paid)} of the deposit paid its registration`)
    + ')'
    + (b.reasons.length > 0 ? `; NOT as expected: ${b.reasons.join('; ')}` : '')
    + (b.notes.length > 0 ? `; ${b.notes.join('; ')}` : '');
}

async function blockTsOf(r) {
  if (!r.blockHash) return null;
  try {
    return await rpc.blockTimestamp(r.blockHash);
  } catch (e) {
    log(`could not read block ${r.blockHash}: ${e.message}`);
    return null;
  }
}

// Ask the faucet to create `signer.id` with the signer's public key.
// Returns { url, tx }: the faucet URL used and, when the faucet's answer carries a
// transaction identifier, a receipts.json transaction record for it (otherwise null).
async function faucetCreate(signer) {
  const errors = [];
  for (const url of FAUCET_URLS) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      let note;
      let polls = 10;
      let tx = null;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newAccountId: signer.id, newAccountPublicKey: signer.pk }),
          signal: AbortSignal.timeout(60_000),
        });
        const raw = await res.text();
        const text = raw.replace(/\s+/g, ' ').slice(0, 200);
        note = `HTTP ${res.status} ${text}`;
        if (res.ok) tx = faucetTx(raw);
        else polls = 2; // a clear refusal; a short look on chain is enough
      } catch (e) {
        note = `request failed: ${e.message}`;
      }
      // The account may exist even when the HTTP call timed out, so always look on chain.
      for (let i = 0; i < polls; i++) {
        if (await rpc.accessKey(signer.id, signer.pk)) return { url, tx };
        await sleep(2000);
      }
      errors.push(`${new URL(url).host} try ${attempt}: ${note}`);
      log(`faucet: ${errors.at(-1)}`);
      await sleep(3000 * attempt);
    }
  }
  throw new Error(`no faucet created ${signer.id}. ${errors.join(' | ')}`);
}

async function balanceOf(accountId) {
  return BigInt((await rpc.viewAccount(accountId)).amount);
}

function mustSucceed(r, what) {
  if (r.outcome !== 'success') throw new Error(`${what} failed: ${r.outcome} ${r.error ?? ''} (tx ${r.hash})`);
  return r;
}

// Read contract state until `ok(value)` holds; the node behind a view may lag a block or two.
async function readUntil(read, ok, tries = 10) {
  let value;
  for (let i = 0; i < tries; i++) {
    value = await read();
    if (ok(value)) return value;
    await sleep(1500);
  }
  return value;
}

// The run

async function main() {
  log(`preset ${PRESET}; rpc ${RPC_URLS.map((u) => new URL(u).host).join(', ')}`);
  presetParams(PRESET, 'check.testnet'); // reject an unsupported preset before any account is created
  if (PRESET !== 'demo') throw new Error(`the proof run supports only the demo preset, not "${PRESET}" (its late-buyer check needs the launch window to close)`);
  const wasm = new Uint8Array(await readFile(WASM_PATH));
  if (wasm.length < 1000 || wasm.length > MAX_TX_BYTES - 2000) throw new Error(`unexpected wasm size: ${wasm.length} bytes`);
  deployment.wasm = { bytes: wasm.length, sha256: createHash('sha256').update(wasm).digest('hex') };
  log(`wasm ${wasm.length} bytes, sha256 ${deployment.wasm.sha256}`);

  // Step 1: root account from the faucet
  const s1 = addStep(1, 'Create a fresh root account through the testnet faucet', 'the account exists and is funded');
  const root = newSigner(`loud-${Date.now().toString(36)}${randomBytes(3).toString('hex')}.testnet`);
  deployment.root_account = root.id;
  deployment.explorer.root = accountLink(root.id);
  const faucet = await faucetCreate(root);
  if (faucet.tx) {
    faucetRecs.add(faucet.tx);
    s1.txs.push(faucet.tx);
  }
  let rootBalance = await balanceOf(root.id);
  let plan = budget({ wasmBytes: wasm.length, balance: rootBalance, wallets: WALLETS });
  // Top-up: if one faucet grant is too small, create up to three more faucet accounts and
  // delete each with the root as beneficiary, which moves its balance to the root.
  for (let i = 1; i <= 3 && !plan.ok; i++) {
    log(`root has ${yoctoToNear(rootBalance)} NEAR, needs ${yoctoToNear(plan.need)}; top-up ${i}`);
    const extra = newSigner(root.id.replace('.testnet', `f${i}.testnet`));
    try {
      const extraFaucet = await faucetCreate(extra);
      if (extraFaucet.tx) {
        faucetRecs.add(extraFaucet.tx);
        s1.txs.push(extraFaucet.tx);
      }
      const r = await sendTx(extra, extra.id, [T.deleteAccount(root.id)]);
      s1.txs.push(txRecord(r));
    } catch (e) {
      log(`top-up ${i} failed: ${e.message}`);
      break;
    }
    rootBalance = await readUntil(() => balanceOf(root.id), (b) => b > rootBalance, 5);
    plan = budget({ wasmBytes: wasm.length, balance: rootBalance, wallets: WALLETS });
  }
  const faucetNote = faucet.tx
    ? `the faucet returned transaction ${faucet.tx.hash} for the account creation, recorded below as returned`
    : "the faucet returned no transaction identifier, so the faucet's own account-creation transaction is not recorded here";
  finishStep(s1, plan.ok, `${root.id} holds ${yoctoToNear(rootBalance)} NEAR (faucet ${new URL(faucet.url).host}); the run needs ${yoctoToNear(plan.need)}; ${faucetNote}`);
  if (!plan.ok) throw new Error('root balance is too small for the run');
  log(`plan: token ${yoctoToNear(plan.tokenDeposit)}, insider ${yoctoToNear(plan.insider)}, late ${yoctoToNear(plan.late)}, each wallet ${yoctoToNear(plan.perWallet)} NEAR (of which ${yoctoToNear(plan.registration)} is its registration)`);

  // Step 3 (runs before step 2 so the loud window is not spent on setup)
  const s3 = addStep(3, `Create the insider, ${WALLETS} split wallets and one late buyer under the root`, `${WALLETS + 2} accounts created`);
  const insider = newSigner(`insider.${root.id}`);
  const late = newSigner(`late.${root.id}`);
  const wallets = Array.from({ length: WALLETS }, (_, i) => newSigner(`w${String(i + 1).padStart(2, '0')}.${root.id}`));
  receipts.accounts = { insider: insider.id, late: late.id, wallets: wallets.map((w) => w.id) };
  deployment.creator_account = insider.id;
  const funding = [[insider, plan.insider], [late, plan.late], ...wallets.map((w) => [w, plan.perWallet])];
  let created = 0;
  for (const [acct, amount] of funding) {
    checkDeadline('creating accounts');
    const r = await sendTx(root, acct.id, [
      T.createAccount(),
      T.transfer(amount),
      T.addKey(acct.kp.getPublicKey(), T.fullAccessKey()),
    ]);
    s3.txs.push(txRecord(r));
    // An unconfirmed send may still have landed, so the chain decides.
    if (r.outcome === 'success' || (r.outcome === 'unknown' && await rpc.accessKey(acct.id, acct.pk))) created += 1;
    else log(`create ${acct.id}: ${r.outcome} ${r.error}`);
  }
  finishStep(s3, created === funding.length, `${created} of ${funding.length} accounts created`);
  if (created !== funding.length) throw new Error('account creation failed');

  // Step 2: token account in one batch transaction, no AddKey
  const s2 = addStep(2, 'Create, fund, deploy and initialise the token account in one transaction with no access key',
    'view_access_key_list returns an empty list; the on-chain code hash equals the hash of the built wasm; get_params equals the preset; '
    + 'storage_balance_bounds().min is 0.03 NEAR, storage_balance_of() of an account that is not registered is null, and the creator is registered');
  const token = `t.${root.id}`;
  const params = presetParams(PRESET, insider.id);
  deployment.token_account = token;
  deployment.params = params;
  deployment.explorer.token = accountLink(token);
  receipts.token_account = token;
  const deploy = await sendTx(root, token, [
    T.createAccount(),
    T.transfer(plan.tokenDeposit),
    T.deployContract(wasm),
    T.functionCall('new', params, 100n * TGAS, 0n),
  ]);
  s2.txs.push(txRecord(deploy));
  deployment.tx = deploy.hash;
  deployment.explorer.tx = deploy.hash ? txLink(deploy.hash) : null;
  mustSucceed(deploy, 'token deploy');
  const deployTs = await blockTsOf(deploy);
  if (deployTs !== null) {
    deployment.deployed_at_ns = deployTs.toString();
    deployment.deployed_at = new Date(Number(deployTs / 1_000_000n)).toISOString();
  }
  const keys = await readUntil(() => rpc.accessKeyList(token).catch(() => null), (k) => Array.isArray(k));
  if (!Array.isArray(keys)) throw new Error('could not read the access key list of the token account');
  deployment.access_keys = keys.map((k) => k.public_key);
  deployment.zero_keys = keys.length === 0;
  // The code hash of an account is the sha256 of its wasm, written in base58.
  const expectedCodeHash = base58Encode(createHash('sha256').update(wasm).digest());
  deployment.expected_code_hash = expectedCodeHash;
  const tokenAccount = await readUntil(() => rpc.viewAccount(token), (a) => a.code_hash === expectedCodeHash, 6);
  deployment.code_hash = tokenAccount.code_hash;
  deployment.code_hash_match = tokenAccount.code_hash === expectedCodeHash;
  // Views retry a few times: the node answering may be a block behind the final transaction.
  const view = async (method, args = {}) => {
    for (let i = 0; ; i++) {
      try {
        return await rpc.viewFunction(token, method, args);
      } catch (e) {
        if (i >= 5) throw e;
        await sleep(1200);
      }
    }
  };
  // NEAR of the token account next to what the contract counts as pool liquidity and as
  // unpaid payouts. Never throws: null when a read failed.
  async function tokenNearNow() {
    try {
      const [acct, st] = await Promise.all([rpc.viewAccount(token), view('get_state')]);
      return tokenNear({ balance: acct.amount, storageBytes: acct.storage_usage, poolNear: st.pool_near, owedTotal: st.owed_total });
    } catch (e) {
      log(`could not read the NEAR of the token account: ${String(e?.message ?? e).slice(0, 160)}`);
      return null;
    }
  }
  // All reads of this step go out together, so that the insider's buy stays well inside
  // the 2 minute loud window. `stranger` is an account name that is never created.
  // A storage view that cannot be read counts as a failed check (undefined), so that the
  // deployment result below is still written.
  const stranger = `nobody.${root.id}`;
  const soft = (read) => read.catch((e) => {
    log(`storage view failed: ${String(e?.message ?? e).slice(0, 160)}`);
    return undefined;
  });
  const [onchain, bounds, strangerBalance, strangerRegistered, creatorRegistered, stateAtDeploy, nearAtDeploy] = await Promise.all([
    view('get_params'),
    soft(view('storage_balance_bounds')),
    soft(view('storage_balance_of', { account_id: stranger })),
    soft(view('is_registered', { account_id: stranger })),
    soft(view('is_registered', { account_id: insider.id })),
    view('get_state'),
    tokenNearNow(),
  ]);
  receipts.token_near.at_deploy = nearAtDeploy;
  const storageMin = bounds?.min === undefined || bounds?.min === null ? null : String(bounds.min);
  // `new` registers the creator, so that the holder of the creator allocation is registered
  // like every other holder.
  const storageOk = storageMin === STORAGE_MIN_YOCTO.toString() && strangerBalance === null && creatorRegistered === true;
  s2.storage = {
    expected_min: STORAGE_MIN_YOCTO.toString(),
    min: storageMin,
    max: bounds?.max === undefined || bounds?.max === null ? null : String(bounds.max),
    unregistered_account: stranger,
    unregistered_balance: strangerBalance === undefined ? 'not read' : strangerBalance,
    unregistered_is_registered: strangerRegistered ?? null,
    creator_is_registered: creatorRegistered ?? null,
    pass: storageOk,
  };
  deployment.onchain_params = onchain;
  const mismatches = paramMismatches(params, onchain);
  deployment.param_mismatches = mismatches;
  deployment.params_match = mismatches.length === 0;
  const deployOk = deployment.zero_keys && deployment.code_hash_match && deployment.params_match;
  // The storage views are part of this step's result. deployment.json keeps its three
  // conditions (zero keys, code hash, parameters).
  finishStep(s2, deployOk && storageOk,
    `${token} has ${keys.length} access keys; code hash on chain ${deployment.code_hash} `
    + `${deployment.code_hash_match ? 'equals' : 'DIFFERS from'} the hash of the built wasm ${expectedCodeHash}; `
    + (deployment.params_match
      ? `get_params equals the ${PRESET} preset (cap_units ${unitsToTokens(onchain.cap_units)} LOUD per ${BigInt(onchain.cap_window_ns) / 10n ** 9n}s)`
      : `get_params differs from the ${PRESET} preset: ${mismatches.join('; ').slice(0, 500)}`)
    + `; storage_balance_bounds().min is ${storageMin === null ? 'missing' : nearText(storageMin)} (expected ${nearText(STORAGE_MIN_YOCTO)}); `
    + `storage_balance_of(${stranger}) is ${strangerBalance === null ? 'null' : strangerBalance === undefined ? 'not read' : JSON.stringify(strangerBalance).slice(0, 120)}; `
    + `the creator ${creatorRegistered === true ? 'is' : 'is NOT'} registered by new`);
  deployment.status = deployOk ? 'ok' : 'failed';
  const capUnits = BigInt(onchain.cap_units);
  const capWindowNs = BigInt(onchain.cap_window_ns);
  const loudUntil = BigInt(onchain.loud_until);
  receipts.split.cap_units = capUnits.toString();
  receipts.split.cap_window_ns = capWindowNs.toString();

  const account = (id) => view('get_account', { account_id: id });
  const chainNow = async () => BigInt((await view('get_state')).now);
  async function waitChainTime(targetNs, what) {
    for (;;) {
      checkDeadline(`waiting for ${what}`);
      const now = await chainNow();
      if (now >= targetNs) return now;
      const left = Number((targetNs - now) / 10n ** 9n);
      log(`waiting for ${what}: ${left}s left`);
      await sleep(Math.min(Math.max(left * 1000, 1500), 15_000));
    }
  }

  // Step 4: insider buys in the loud window
  // The insider is the creator, which `new` registered, so its buy should pay nothing for
  // storage. The check takes the registration state and pool_near as read in step 2, a
  // moment ago, and does not assume either.
  const s4 = addStep(4, 'The insider buys with 1 NEAR during the loud window',
    'the bought tokens are loud; quiet balance is 0; pool_near rises by the attached NEAR less the registration payment, which is 0 for an account that is registered already');
  const before4 = await account(insider.id);
  const buy = await call(insider, token, 'buy', { min_tokens_out: '1' }, { gas: 50n * TGAS, deposit: nearToYocto('1') });
  s4.txs.push(txRecord(buy));
  const state4 = await readUntil(() => view('get_state'),
    (st) => buy.outcome !== 'success' || BigInt(st.pool_near) !== BigInt(stateAtDeploy.pool_near));
  const buy4 = evaluateBuy({
    attached: nearToYocto('1'),
    registeredBefore: creatorRegistered,
    poolNearBefore: stateAtDeploy.pool_near,
    poolNearAfter: state4.pool_near,
    event: buyEvent(buy.logs),
  });
  s4.buy = buy4.record;
  const bought = returnValueBigInt(buy.successValue) ?? 0n;
  const after4 = await readUntil(() => account(insider.id), (a) => buy.outcome !== 'success' || BigInt(a.loud) > BigInt(before4.loud));
  const insiderLoud = BigInt(after4.loud);
  finishStep(s4, buy.outcome === 'success' && insiderLoud > BigInt(before4.loud) && BigInt(after4.quiet) === 0n && buy4.pass,
    `loud ${unitsToTokens(before4.loud)} -> ${unitsToTokens(insiderLoud)} LOUD (bought ${unitsToTokens(bought)}), quiet ${after4.quiet}${buy.error ? `; ${buy.error}` : ''}; ${buyText(buy4)}`);
  if (insiderLoud === 0n) throw new Error('the insider holds no loud tokens; nothing to split');

  // Step 5: split across the wallets
  const s5 = addStep(5, `The insider splits its whole loud balance across ${WALLETS} wallets with ft_transfer`,
    'every wallet holds loud tokens and no quiet tokens; the insider holds 0. Before the split: a transfer of 1 unit to a wallet '
    + 'that is not registered fails with E_UNREGISTERED, then every wallet registers itself with storage_deposit (0.03 NEAR)');
  // An account has to be registered before it can receive tokens. First the refusal: one
  // unit to a wallet that has not paid its registration yet.
  const probeTo = wallets[0];
  const probeRegistered = await view('is_registered', { account_id: probeTo.id });
  const probe = await call(insider, token, 'ft_transfer', { receiver_id: probeTo.id, amount: '1' }, { deposit: ONE_YOCTO });
  s5.txs.push(txRecord(probe));
  const probeOk = probeRegistered === false && probe.outcome === 'failure' && probe.code === 'E_UNREGISTERED';
  s5.unregistered_transfer = {
    receiver: probeTo.id,
    registered_before: probeRegistered,
    amount: '1',
    hash: probe.hash,
    outcome: probe.outcome,
    error_code: probe.code,
    pass: probeOk,
  };
  // Then every wallet pays its own registration, all at the same time. The deposit is
  // exactly the minimum, so there is nothing to refund.
  const register = (w) => call(w, token, 'storage_deposit', { registration_only: true }, { deposit: STORAGE_MIN_YOCTO });
  const isRegistered = (w) => readUntil(() => view('is_registered', { account_id: w.id }), (v) => v === true, 6);
  const deposits = await Promise.all(wallets.map(register));
  deposits.forEach((r) => s5.txs.push(txRecord(r)));
  const registered = await Promise.all(wallets.map(isRegistered));
  // The chain decides, not the send result. A wallet that is still not registered sends
  // once more; a second deposit to a registered account is refunded in full.
  for (let i = 0; i < WALLETS; i++) {
    if (registered[i] === true) continue;
    checkDeadline('registering the wallets');
    log(`storage_deposit of ${wallets[i].id}: ${deposits[i].outcome} ${deposits[i].error ?? ''}; sending once more`);
    s5.txs.push(txRecord(await register(wallets[i])));
    registered[i] = await isRegistered(wallets[i]);
  }
  const registeredCount = registered.filter((v) => v === true).length;
  s5.registration = { deposit: STORAGE_MIN_YOCTO.toString(), wallets: WALLETS, registered: registeredCount };
  // The refused transfer moved nothing. If it did go through, split what is left.
  const toSplit = probe.outcome === 'failure' ? insiderLoud : BigInt((await account(insider.id)).loud);
  const parts = splitEvenly(toSplit, WALLETS);
  for (let i = 0; i < WALLETS; i++) {
    checkDeadline('splitting');
    const r = await call(insider, token, 'ft_transfer', { receiver_id: wallets[i].id, amount: parts[i].toString() }, { deposit: ONE_YOCTO });
    s5.txs.push(txRecord(r));
    if (r.outcome !== 'success') log(`ft_transfer to ${wallets[i].id}: ${r.outcome} ${r.error}`);
  }
  await readUntil(() => account(wallets[WALLETS - 1].id), (a) => BigInt(a.loud) === parts[WALLETS - 1], 6);
  let balances = await Promise.all(wallets.map((w) => account(w.id)));
  // The chain decides here too. A transfer whose outcome never came back and whose
  // tokens did not arrive is sent once more; the earlier send is listed above.
  for (let i = 0; i < WALLETS; i++) {
    if (BigInt(balances[i].loud) === parts[i]) continue;
    checkDeadline('splitting');
    log(`ft_transfer to ${wallets[i].id} did not arrive; sending once more`);
    const r = await call(insider, token, 'ft_transfer', { receiver_id: wallets[i].id, amount: parts[i].toString() }, { deposit: ONE_YOCTO });
    s5.txs.push(txRecord(r));
    await readUntil(() => account(wallets[i].id), (a) => BigInt(a.loud) === parts[i], 6);
  }
  balances = await Promise.all(wallets.map((w) => account(w.id)));
  const insiderAfter = await account(insider.id);
  s5.balances = wallets.map((w, i) => ({ account: w.id, loud: String(balances[i].loud), quiet: String(balances[i].quiet) }));
  const loudOk = balances.every((b, i) => BigInt(b.loud) === parts[i] && BigInt(b.quiet) === 0n);
  finishStep(s5, loudOk && BigInt(insiderAfter.loud) === 0n && probeOk && registeredCount === WALLETS,
    `${balances.filter((b) => BigInt(b.loud) > 0n).length} wallets hold loud, about ${unitsToTokens(parts[0])} LOUD each; insider loud ${insiderAfter.loud}; `
    + `before the split, 1 unit to ${probeTo.id} (${probeRegistered === false ? 'not registered' : 'registration state not as expected'}): ${probe.outcome}: ${probe.error ?? 'no error'}; `
    + `${registeredCount} of ${WALLETS} wallets registered with storage_deposit, ${nearText(STORAGE_MIN_YOCTO)} each`);

  // Step 6: a split wallet cannot use sell()
  const s6 = addStep(6, 'A split wallet tries sell() with its loud tokens', 'the call fails with E_NO_QUIET');
  const sellTry = await call(wallets[0], token, 'sell', { amount: parts[0].toString(), min_near_out: '0' }, { gas: PAY_GAS, deposit: ONE_YOCTO });
  s6.txs.push(txRecord(sellTry));
  finishStep(s6, sellTry.outcome === 'failure' && sellTry.code === 'E_NO_QUIET', `${sellTry.outcome}: ${sellTry.error ?? 'no error'}`);

  // Step 7: a late buyer stays quiet and can sell at once
  const s7 = addStep(7, 'After the loud window a late buyer buys with 0.5 NEAR and sells half at once',
    'the late buyer holds quiet tokens only; its first buy registers it: 0.03 NEAR of the deposit pays the registration and pool_near rises by the rest; '
    + 'the sell succeeds and none of its receipts failed');
  await waitChainTime(loudUntil + 1n, 'the end of the loud window');
  const [lateRegistered, state7] = await Promise.all([view('is_registered', { account_id: late.id }), view('get_state')]);
  const lateBuy = await call(late, token, 'buy', { min_tokens_out: '1' }, { gas: 50n * TGAS, deposit: nearToYocto('0.5') });
  s7.txs.push(txRecord(lateBuy));
  const lateAfterBuy = await readUntil(() => account(late.id), (a) => lateBuy.outcome !== 'success' || BigInt(a.quiet) > 0n);
  const lateQuiet = BigInt(lateAfterBuy.quiet);
  // Read before the sell goes out, which lowers pool_near again.
  const state7b = await readUntil(() => view('get_state'),
    (st) => lateBuy.outcome !== 'success' || BigInt(st.pool_near) !== BigInt(state7.pool_near));
  const [lateRegisteredAfter, lateStorage] = await Promise.all([
    readUntil(() => view('is_registered', { account_id: late.id }), (v) => lateBuy.outcome !== 'success' || v === true, 6),
    view('storage_balance_of', { account_id: late.id }),
  ]);
  const buy7 = evaluateBuy({
    attached: nearToYocto('0.5'),
    registeredBefore: lateRegistered,
    poolNearBefore: state7.pool_near,
    poolNearAfter: state7b.pool_near,
    event: buyEvent(lateBuy.logs),
  });
  s7.buy = {
    ...buy7.record,
    registered_after: lateRegisteredAfter,
    storage_balance_total: lateStorage?.total === undefined || lateStorage?.total === null ? null : String(lateStorage.total),
  };
  let lateSell = null;
  if (lateQuiet > 1n) {
    lateSell = await call(late, token, 'sell', { amount: (lateQuiet / 2n).toString(), min_near_out: '0' }, { gas: PAY_GAS, deposit: ONE_YOCTO });
    s7.txs.push(payRecord(lateSell));
  }
  const sellSettled = lateSell?.outcome === 'success' && lateSell.settled === true;
  s7.payout_calls = lateSell?.outcome === 'success' ? 1 : 0;
  s7.payouts_settled = sellSettled ? 1 : 0;
  finishStep(s7, lateBuy.outcome === 'success' && BigInt(lateAfterBuy.loud) === 0n && lateQuiet > 0n && sellSettled
    && buy7.pass && lateRegistered === false && lateRegisteredAfter === true,
    `after buy: loud ${lateAfterBuy.loud}, quiet ${unitsToTokens(lateQuiet)} LOUD; ${buyText(buy7)}; `
    + `is_registered after the buy: ${lateRegisteredAfter}; sell of half: ${lateSell ? lateSell.outcome : 'not sent'}${lateSell?.error ? ` (${lateSell.error})` : ''}`
    + (lateSell?.outcome === 'success' ? `; payout receipts: ${sellSettled ? 'all succeeded' : `NOT settled (${lateSell.receiptError ?? 'unknown'})`}` : ''));

  // Step 8: every wallet shouts; an early leave is rejected
  const s8 = addStep(8, `All ${WALLETS} wallets shout their full balance; one tries leave() and then hush() before the notice ends; the late buyer catches a quarter of another exit`,
    `${WALLETS} open exits; the early leave fails with E_NOTICE; the hush of the same exit by its owner fails with E_NOTICE_BINDING and the exit stays open; `
    + 'an owner catching its own exit fails with E_SELF; the catch by the late buyer succeeds: it receives the tokens as loud, the exit shrinks by the same amount, '
    + 'pool_tokens does not change, pool_near rises by the 1% fee only and the cap room does not fall');
  const shouts = await Promise.all(wallets.map((w, i) => call(w, token, 'shout', { amount: parts[i].toString() }, { deposit: ONE_YOCTO })));
  shouts.forEach((r) => s8.txs.push(txRecord(r)));
  // The early leave goes out at once, while the notice of the exit just opened is still running.
  // The same wallet then tries to take its notice back. A shout is binding: hush fails for
  // everyone, the owner included, until the exit has expired.
  let early = null;
  let earlyHush = null;
  let earlyExitId = null;
  async function earlyCalls(wallet, exitId) {
    earlyExitId = exitId;
    early = await call(wallet, token, 'leave', { exit_id: exitId, min_near_out: '0' }, { gas: PAY_GAS, deposit: ONE_YOCTO });
    s8.txs.push(txRecord(early));
    earlyHush = await call(wallet, token, 'hush', { exit_id: exitId }, { deposit: ONE_YOCTO });
    s8.txs.push(txRecord(earlyHush));
  }
  const firstShout = shouts.findIndex((r) => r.outcome === 'success' && returnValueBigInt(r.successValue) !== null);
  if (firstShout >= 0) {
    await earlyCalls(wallets[firstShout], returnValueBigInt(shouts[firstShout].successValue).toString());
  }
  const afterShout = await Promise.all(wallets.map((w) => readUntil(() => account(w.id), (a) => (a.exits ?? []).length > 0, 4)));
  const exits = wallets.map((w, i) => {
    const e = (afterShout[i].exits ?? [])[0];
    return e ? { wallet: w, id: String(e.id), amount: String(e.amount), readyAt: BigInt(e.ready_at), expiresAt: BigInt(e.expires_at) } : null;
  });
  const open = exits.filter(Boolean);
  s8.exits = open.map((e) => ({ id: e.id, account: e.wallet.id, amount: e.amount, ready_at: e.readyAt.toString(), expires_at: e.expiresAt.toString() }));
  if (early === null && open.length > 0) {
    // The shout return value was not readable; use the exit id from get_account instead.
    await earlyCalls(open[0].wallet, open[0].id);
  }
  // In the usual path the exits above were read after the hush, so an exit that is still
  // listed was not cancelled. The block time says whether the hush landed inside the notice;
  // it has to fail either way, because the exit has not expired.
  const hushedExit = earlyExitId === null ? null : (open.find((e) => e.id === earlyExitId) ?? null);
  const hushTs = earlyHush ? await blockTsOf(earlyHush) : null;
  const hushOk = earlyHush?.outcome === 'failure' && earlyHush.code === 'E_NOTICE_BINDING' && hushedExit !== null;
  s8.early_leave = early ? { account: early.account, exit_id: earlyExitId, hash: early.hash, outcome: early.outcome, error_code: early.code } : null;
  s8.early_hush = earlyHush ? {
    account: earlyHush.account,
    exit_id: earlyExitId,
    hash: earlyHush.hash,
    outcome: earlyHush.outcome,
    error_code: earlyHush.code,
    block_timestamp: hushTs === null ? null : hushTs.toString(),
    ready_at: hushedExit ? hushedExit.readyAt.toString() : null,
    before_ready: hushTs !== null && hushedExit ? hushTs < hushedExit.readyAt : null,
    exit_still_open: hushedExit !== null,
    pass: hushOk,
  } : null;
  // The catch (SPEC section 7): while the notices run, the late buyer takes a quarter of one
  // other exit by paying its owner the price quote_catch names (the pool's sell quote now, or its quote at the shout if higher). The tokens stay loud, the
  // pool keeps its tokens and gains the 1% fee only, and the cap is not used. First the
  // refusal: the owner of that exit cannot catch it itself.
  let selfCatch = null;
  let caught = null;
  let catchEval = null;
  const target = open.find((e) => e.id !== earlyExitId) ?? null;
  s8.catch = null;
  s8.self_catch = null;
  if (target !== null) {
    try {
      const readTarget = async () => ((await account(target.wallet.id)).exits ?? []).find((x) => String(x.id) === target.id) ?? null;
      const exitBefore = await readTarget();
      const remainingBefore = exitBefore ? BigInt(exitBefore.remaining ?? exitBefore.amount) : 0n;
      const catchAmount = remainingBefore / 4n;
      if (catchAmount === 0n) throw new Error(`exit ${target.id} has nothing left to catch`);
      const quote = await view('quote_catch', { exit_id: target.id, amount: catchAmount.toString() });
      const deposit = catchDeposit(quote.near_in);
      // The late buyer was registered by its buy in step 7. If that did not happen, it
      // registers now, so the catch is not refused for a reason this step does not test.
      if (await view('is_registered', { account_id: late.id }) !== true) {
        const reg = await call(late, token, 'storage_deposit', {}, { gas: CATCH_GAS, deposit: STORAGE_MIN_YOCTO });
        s8.txs.push(txRecord(reg));
      }
      // A result no endpoint confirmed is looked up once more by hash before it is judged.
      const confirmed = async (r) => {
        if (r.outcome !== 'unknown' || !r.hash) return r;
        const look = await lookupTx(r.hash, r.account);
        return look.found ? { ...look.found, method: r.method, earlierAttempts: r.earlierAttempts, resolvedLate: true } : r;
      };
      selfCatch = await confirmed(await call(target.wallet, token, 'catch', { exit_id: target.id, amount: catchAmount.toString() }, { gas: CATCH_GAS, deposit }));
      s8.txs.push(txRecord(selfCatch));
      s8.self_catch = { account: selfCatch.account, exit_id: target.id, hash: selfCatch.hash, outcome: selfCatch.outcome, error_code: selfCatch.code };
      const [catcherBefore, stateBefore] = await Promise.all([account(late.id), view('get_state')]);
      caught = await confirmed(await call(late, token, 'catch', { exit_id: target.id, amount: catchAmount.toString() }, { gas: CATCH_GAS, deposit }));
      // A catch pays NEAR to the exit owner and refunds the margin, so the record carries `settled`.
      s8.txs.push(payRecord(caught));
      const catchTs = await blockTsOf(caught);
      const moved = caught.outcome === 'success';
      const [catcherAfter, stateAfter, exitAfter] = await Promise.all([
        readUntil(() => account(late.id), (a) => !moved || BigInt(a.loud) !== BigInt(catcherBefore.loud), 6),
        readUntil(() => view('get_state'), (st) => !moved || String(st.catch_count) !== String(stateBefore.catch_count), 6),
        readUntil(readTarget, (x) => !moved || x === null || BigInt(x.remaining ?? x.amount) !== remainingBefore, 6),
      ]);
      catchEval = evaluateCatch({
        amount: catchAmount,
        quote,
        outcome: caught.outcome,
        settled: caught.settled,
        returned: returnValueBigInt(caught.successValue),
        catcherBefore,
        catcherAfter,
        remainingBefore,
        remainingAfter: exitAfter ? BigInt(exitAfter.remaining ?? exitAfter.amount) : 0n,
        stateBefore,
        stateAfter,
        event: catchEvent(caught.logs),
      });
      s8.catch = {
        exit_id: target.id,
        owner: target.wallet.id,
        catcher: late.id,
        hash: caught.hash,
        outcome: caught.outcome,
        error_code: caught.code,
        attached: deposit.toString(),
        block_timestamp: catchTs === null || catchTs === undefined ? null : catchTs.toString(),
        ready_at: target.readyAt.toString(),
        before_ready: catchTs === null || catchTs === undefined ? null : catchTs < target.readyAt,
        ...catchEval.record,
        reasons: catchEval.reasons,
        notes: catchEval.notes,
      };
    } catch (e) {
      log(`the catch could not be run: ${String(e?.message ?? e).slice(0, 200)}`);
      s8.catch_error = String(e?.message ?? e).slice(0, 300);
    }
  }
  const selfCatchOk = selfCatch?.outcome === 'failure' && selfCatch.code === 'E_SELF';
  const catchOk = catchEval?.pass === true;
  const catchText = target === null ? 'no second exit to catch from'
    : s8.catch_error ? `not run (${s8.catch_error})`
    : `the owner of exit ${target.id} catching it: ${selfCatch ? `${selfCatch.outcome}: ${selfCatch.error ?? 'no error'}` : 'not sent'}; `
      + `the late buyer catching ${catchEval ? unitsToTokens(catchEval.record.amount) : '?'} LOUD of it`
      + `${s8.catch?.before_ready === true ? ' during the notice' : s8.catch?.before_ready === false ? ' after the notice, before expiry' : ''}: `
      + (caught ? `${caught.outcome}${caught.error ? ` (${caught.error})` : ''}` : 'not sent')
      + (catchEval && caught?.outcome === 'success'
        ? `, paid ${nearText(catchEval.record.near_in)} of which ${nearText(catchEval.record.fee)} stayed in the pool; `
          + `its loud balance ${unitsToTokens(catchEval.record.catcher_loud_before ?? 0)} -> ${unitsToTokens(catchEval.record.catcher_loud_after ?? 0)} LOUD, `
          + `pool_tokens changed by ${catchEval.record.pool_tokens_change}, cap room ${unitsToTokens(catchEval.record.cap_available_before ?? 0)} -> ${unitsToTokens(catchEval.record.cap_available_after ?? 0)} LOUD`
        : '')
      + (catchEval && catchEval.reasons.length > 0 ? `; NOT as expected: ${catchEval.reasons.join('; ')}` : '')
      + (catchEval && catchEval.notes.length > 0 ? `; ${catchEval.notes.join('; ')}` : '');
  finishStep(s8, open.length === WALLETS && early?.outcome === 'failure' && early.code === 'E_NOTICE' && hushOk && selfCatchOk && catchOk,
    `${open.length} open exits (ids ${open.map((e) => e.id).join(',')}); early leave: ${early ? `${early.outcome}: ${early.error ?? 'no error'}` : 'not sent'}; `
    + `hush of exit ${earlyExitId ?? '-'} by its owner${s8.early_hush?.before_ready === true ? ' during the notice' : s8.early_hush?.before_ready === false ? ' after the notice, before expiry' : ''}: `
    + `${earlyHush ? `${earlyHush.outcome}: ${earlyHush.error ?? 'no error'}` : 'not sent'}; the exit is ${hushedExit !== null ? 'still open' : 'NOT listed as open'}; ${catchText}`);
  if (open.length === 0) throw new Error('no exit was opened; cannot run the leave test');

  // Step 9: all wallets leave for one cap window
  const s9 = addStep(9, `After the notice, all ${WALLETS} wallets call leave() in rounds for one full cap window`,
    'at least one fill; every call that executed and failed did so with E_CAP (or E_EXPIRED at the very end); no successful leave has a failed receipt or a payout_failed event; calls that were not executed or whose outcome stayed unknown are counted apart');
  const readyAt = open.reduce((m, e) => (e.readyAt > m ? e.readyAt : m), 0n);
  await waitChainTime(readyAt, 'the end of the notice period');
  const state0 = await view('get_state');
  const t0 = BigInt(state0.now);
  const bucketAtStart = BigInt(state0.cap_available);
  const totalLeft0 = BigInt(state0.total_left);
  const windowEnd = t0 + capWindowNs;
  Object.assign(receipts.split, {
    bucket_at_start: bucketAtStart.toString(),
    window_start_ns: t0.toString(),
    window_end_ns: windowEnd.toString(),
  });
  log(`cap window starts: bucket ${unitsToTokens(bucketAtStart)} LOUD, cap ${unitsToTokens(capUnits)} LOUD per window`);

  const attempts = [];
  const trail = []; // { rec, e, blockHash } per leave call, for the re-check after the loop
  let active = [...open];
  let lastTs = t0;
  let cutShort = null; // set when the measurement could not run to the end of the cap window
  const wallStart = Date.now();
  const capWindowMs = Number(capWindowNs / 1_000_000n);

  // The fields of a leave record that come from the transaction result.
  async function leaveFields(r) {
    const ts = await blockTsOf(r);
    let filled = null;
    let remaining = null;
    if (r.outcome === 'success') ({ filled, remaining } = leaveFilled(r));
    if (ts !== null && ts > lastTs) lastTs = ts;
    return {
      remaining,
      fields: {
        filled: filled === null ? null : filled.toString(),
        error_code: r.code,
        block_timestamp: ts === null ? null : ts.toString(),
      },
    };
  }

  async function leaveOnce(e, round) {
    const r = await call(e.wallet, token, 'leave', { exit_id: e.id, min_near_out: '0' }, { gas: PAY_GAS, deposit: ONE_YOCTO });
    const { remaining, fields } = await leaveFields(r);
    // A successful leave pays NEAR, so the record carries `settled` (all receipts succeeded).
    const rec = payRecord(r, { round, exit_id: e.id, ...fields });
    leaveRecs.add(rec);
    attempts.push(rec);
    s9.txs.push(rec);
    trail.push({ rec, e, blockHash: r.blockHash });
    const done = r.outcome === 'success' && remaining === 0n;
    const expired = r.code === 'E_EXPIRED';
    if (r.outcome !== 'success' && r.code !== 'E_CAP' && !expired) log(`leave ${e.wallet.id}: ${r.outcome} ${r.error}`);
    return { e, r, stop: done || expired || r.outcome === 'invalid' };
  }

  for (let round = 1; active.length > 0; round++) {
    const roundStart = Date.now();
    // Every wallet that still has an open exit sends again each round, so a wallet that
    // hit E_CAP is retried in the next round.
    const results = await Promise.all(active.map((e) => leaveOnce(e, round)));
    const stopped = new Set(results.filter((x) => x.stop).map((x) => x.e));
    active = active.filter((e) => !stopped.has(e));
    const roundFilled = results.reduce((s, x) => s + (x.r.outcome === 'success' ? (leaveFilled(x.r).filled ?? 0n) : 0n), 0n);
    log(`round ${round}: ${results.length} calls, ${results.filter((x) => x.r.outcome === 'success').length} filled ${unitsToTokens(roundFilled)} LOUD, ${results.filter((x) => x.r.code === 'E_CAP').length} E_CAP, ${active.length} wallets active`);
    if (lastTs >= windowEnd || Date.now() - wallStart > capWindowMs + 30_000) break;
    if (Date.now() - startedAt > MAX_RUNTIME_MS) {
      cutShort = 'the runtime limit was reached during the leave rounds';
      log('runtime limit reached; closing the leave loop early');
      break;
    }
    await sleep(Math.max(0, ROUND_MS - (Date.now() - roundStart)));
  }

  // Before step 9 is closed: one more lookup by hash for every leave whose result no
  // endpoint confirmed, for every earlier broadcast that a retry replaced, and for fills
  // without a block time. Step 10 needs every fill on record with its time, or it fails.
  // What is still unknown after this is counted as unresolved, never as "not executed".
  // (The loop also visits the records it appends.)
  const lookupUntil = startedAt + MAX_RUNTIME_MS;
  for (const p of trail) {
    const { rec } = p;
    if (Date.now() > lookupUntil) break;
    try {
      if (needsLookup(rec)) {
        const look = await lookupTx(rec.hash, rec.account);
        if (look.found) {
          const r = look.found;
          const { fields } = await leaveFields(r);
          Object.assign(rec, payRecord(r, { round: rec.round, exit_id: rec.exit_id, ...fields }), { resolved_late: true });
          p.blockHash = r.blockHash;
          log(`leave ${rec.hash} was confirmed on a second look: ${rec.outcome}`);
        } else {
          log(`leave ${rec.hash} is still unconfirmed: ${look.error}`);
        }
      }
      // An earlier broadcast that did execute is a leave call of its own: it gets its own
      // record, so that its fill (if any) is on record for step 10.
      for (const found of await resolveEarlier(rec, lookupUntil)) {
        const r = { ...found, method: 'leave' };
        const { fields } = await leaveFields(r);
        const extra = payRecord(r, { round: rec.round, exit_id: rec.exit_id, ...fields, retried_as: rec.hash });
        leaveRecs.add(extra);
        attempts.push(extra);
        s9.txs.push(extra);
        trail.push({ rec: extra, e: p.e, blockHash: r.blockHash });
      }
    } catch (e) {
      log(`second look at leave ${rec.hash} failed: ${String(e?.message ?? e).slice(0, 160)}`);
    }
    if (rec.filled !== null && rec.block_timestamp === null && p.blockHash) {
      try {
        const ts = await rpc.blockTimestamp(p.blockHash);
        rec.block_timestamp = ts.toString();
        if (ts > lastTs) lastTs = ts;
      } catch (e) {
        log(`no block time for leave ${rec.hash}: ${String(e?.message ?? e).slice(0, 160)}`);
      }
    }
  }

  // Three groups stay apart: executed and failed (E_CAP, E_EXPIRED, other), not executed
  // ("invalid", or never broadcast) and unresolved (broadcast, outcome unknown). Only an
  // executed call that failed for a reason other than E_CAP / E_EXPIRED is an unexpected
  // failure. An unresolved call does not fail this step; the run result carries it
  // (`unresolved_txs`). If such a call did change the contract counter, step 10 fails
  // because the fills on record no longer add up to the counter.
  const c9 = leaveCounts(attempts);
  const fillsCount = c9.fills;
  const unexpected = c9.other_failures;
  const payoutCalls = c9.payout_calls;
  const payoutsSettled = c9.payouts_settled;
  s9.payout_calls = payoutCalls;
  s9.payouts_settled = payoutsSettled;
  s9.executed_failed = c9.executed_failed;
  s9.not_executed = c9.not_executed;
  s9.unresolved = c9.unresolved;
  receipts.split.attempts = attempts.length;
  receipts.split.cap_hits = c9.cap_hits;
  receipts.split.payout_calls = payoutCalls;
  receipts.split.payouts_settled = payoutsSettled;
  receipts.split.executed_failed = c9.executed_failed;
  receipts.split.not_executed = c9.not_executed;
  receipts.split.unresolved = c9.unresolved;
  finishStep(s9, fillsCount > 0 && unexpected === 0 && payoutsSettled === payoutCalls, leaveCountsText(c9, open.length));

  // Step 10: the cap held
  const s10 = addStep(10, 'Total loud units that left during the cap window stay within the cap',
    'measured over the full cap window: sold <= bucket_at_start + cap_units * elapsed / cap_window (SPEC invariant 4), and the per-transaction fills add up to the contract counter');
  // The measurement closes only after chain time has passed the end of the cap window.
  // If that cannot be reached (runtime limit, RPC failure), step 10 is recorded as failed.
  if (cutShort === null) {
    try {
      await waitChainTime(windowEnd, 'the end of the cap window');
    } catch (e) {
      cutShort = String(e?.message ?? e).slice(0, 200);
      log(`the cap window was not measured to its end: ${cutShort}`);
    }
  }
  const closeAt = cutShort === null && windowEnd > lastTs ? windowEnd : lastTs;
  const state1 = await readUntil(() => view('get_state'), (s) => BigInt(s.now) >= closeAt, 12);
  const t1 = BigInt(state1.now) > lastTs ? BigInt(state1.now) : lastTs;
  const ev = evaluateSplit({
    attempts, bucketAtStart, capUnits, capWindowNs, t0, t1,
    totalLeftDelta: BigInt(state1.total_left) - totalLeft0,
  });
  const reasons = [...ev.reasons];
  if (cutShort !== null) reasons.push(`the run was cut short: ${cutShort}`);
  const pass10 = ev.pass && cutShort === null;
  Object.assign(receipts.split, {
    measured_until_ns: t1.toString(),
    sold_in_window: ev.soldInWindow.toString(),
    sold_total: ev.soldTotal.toString(),
    bound: ev.bound.toString(),
    fills: ev.fills,
    receipts_match_counter: ev.receiptsMatchCounter,
    measured_ns: ev.measuredNs.toString(),
    full_window: ev.fullWindow,
    timestamps_valid: ev.timestampsValid,
    fail_reasons: reasons,
    pass: pass10,
  });
  finishStep(s10, pass10,
    `${open.length} wallets sold ${unitsToTokens(ev.soldTotal)} LOUD in ${(t1 - t0) / 10n ** 9n}s (cap window ${capWindowNs / 10n ** 9n}s); bound ${unitsToTokens(ev.bound)} LOUD `
    + `(bucket ${unitsToTokens(bucketAtStart)} + refill); in the window: ${unitsToTokens(ev.soldInWindow)} <= ${unitsToTokens(ev.looseBound)}; `
    + `receipts ${ev.receiptsMatchCounter ? 'match' : 'do not match'} the contract counter`
    + '; the cap check rests on the contract counter total_left, not on the per-transaction statuses'
    + (c9.unresolved > 0
      ? `; unresolved leave calls: ${c9.unresolved}. `
        + (ev.receiptsMatchCounter ? 'The fills on record add up to the counter, so none of them added a fill in the measured interval, but it' : 'It')
        + ' is not known whether each of them never executed or executed and failed'
      : '')
    + (reasons.length > 0 ? `; not passed because: ${reasons.join('; ').slice(0, 600)}` : ''));

  // Closing record: unpaid payouts and the NEAR of the token account
  // Recorded only: no step result depends on it. tokenNearNow() never throws.
  const nearAtEnd = await tokenNearNow();
  receipts.token_near.at_end = nearAtEnd;
  receipts.owed_total_at_end = nearAtEnd?.owed_total ?? null;
  if (nearAtEnd) {
    log(`at the end: owed_total ${nearAtEnd.owed_total}; the token account holds ${nearText(nearAtEnd.balance)}, pool_near is ${nearText(nearAtEnd.pool_near)}, `
      + `spare ${nearText(nearAtEnd.spare)}; the protocol locks ${nearText(nearAtEnd.storage_stake)} for ${nearAtEnd.storage_bytes} bytes of state; free ${nearText(nearAtEnd.free)}`);
  }
}

// MODE=deploy: a faucet account creates, funds, deploys and initialises the token account
// in one transaction that adds no key, with itself as the creator (0% allocation in the
// live preset). The checks are those of step 2: no access key, the code hash of the built
// wasm, get_params equal to the preset. Writes web/live.json. Returns the exit code.
async function deployOnly() {
  log(`deploy only; preset ${PRESET}; rpc ${RPC_URLS.map((u) => new URL(u).host).join(', ')}`);
  const doc = { token: null, root: null, params: null, onchain: null, tx: null, keys: null, codeHash: null,
    expectedCodeHash: null, mismatches: null, deployTsNs: null, wasm: null,
    run: { repository: env.GITHUB_REPOSITORY || null, run_id: env.GITHUB_RUN_ID || null, commit: env.GITHUB_SHA || null } };
  let error = null;
  try {
    const wasm = new Uint8Array(await readFile(WASM_PATH));
    if (wasm.length < 1000 || wasm.length > MAX_TX_BYTES - 2000) throw new Error(`unexpected wasm size: ${wasm.length} bytes`);
    doc.wasm = { bytes: wasm.length, sha256: createHash('sha256').update(wasm).digest('hex') };
    doc.expectedCodeHash = base58Encode(createHash('sha256').update(wasm).digest());
    const root = newSigner(`loud-live-${Date.now().toString(36)}${randomBytes(3).toString('hex')}.testnet`);
    doc.root = root.id;
    doc.token = `t.${root.id}`;
    doc.params = presetParams(PRESET, root.id);
    const faucet = await faucetCreate(root);
    const balance = await balanceOf(root.id);
    const tokenDeposit = BigInt(wasm.length) * 10n ** 19n + nearToYocto('0.5'); // code + state margin
    log(`${root.id} holds ${yoctoToNear(balance)} NEAR (faucet ${new URL(faucet.url).host}); the token account gets ${yoctoToNear(tokenDeposit)}`);
    if (balance < tokenDeposit + nearToYocto('0.3')) throw new Error('the faucet grant is too small for the deploy');
    const deploy = await sendTx(root, doc.token, [
      T.createAccount(),
      T.transfer(tokenDeposit),
      T.deployContract(wasm),
      T.functionCall('new', doc.params, 100n * TGAS, 0n),
    ]);
    doc.tx = deploy.hash;
    mustSucceed(deploy, 'token deploy');
    doc.deployTsNs = await blockTsOf(deploy);
    const keys = await readUntil(() => rpc.accessKeyList(doc.token).catch(() => null), (k) => Array.isArray(k));
    if (!Array.isArray(keys)) throw new Error('could not read the access key list of the token account');
    doc.keys = keys.map((k) => k.public_key);
    const account = await readUntil(() => rpc.viewAccount(doc.token), (a) => a.code_hash === doc.expectedCodeHash, 6);
    doc.codeHash = account.code_hash;
    doc.onchain = await readUntil(() => rpc.viewFunction(doc.token, 'get_params').catch(() => null), (v) => v !== null, 8);
    if (!doc.onchain) throw new Error('could not read get_params');
    doc.mismatches = paramMismatches(doc.params, doc.onchain);
  } catch (e) {
    error = String(e?.message ?? e).slice(0, 600);
    console.error(`deploy stopped: ${error}`);
  }
  const live = liveDocument({ ...doc, now: new Date().toISOString() });
  if (error) live.error = error;
  await mkdir(WEB_DIR, { recursive: true });
  await writeFile(path.join(WEB_DIR, 'live.json'), JSON.stringify(live, jsonReplacer, 2) + '\n');
  log(`wrote web/live.json: ${live.status}; token ${live.token_account}; ${live.access_keys?.length ?? '?'} access keys; `
    + `code hash ${live.code_hash_match ? 'matches' : 'DIFFERS'}; params ${live.params_match ? 'match' : 'DIFFER'}; launch window until ${live.loud_until}`);
  return live.status === 'ok' ? 0 : 1;
}

if (MODE === 'deploy') process.exit(await deployOnly());
if (MODE !== 'proof') {
  console.error(`unknown MODE "${MODE}"`);
  process.exit(1);
}

let exitCode = 1;
try {
  await main();
  const allOk = receipts.steps.length === 10 && receipts.steps.every((s) => s.ok);
  receipts.status = allOk ? 'ok' : 'failed';
  exitCode = allOk ? 0 : 1;
} catch (e) {
  receipts.status = 'failed';
  receipts.error = String(e?.message ?? e).slice(0, 600);
  console.error(`proof run stopped: ${receipts.error}`);
} finally {
  if (deployment.status !== 'ok') deployment.status = 'failed';
  // Whatever the run sent and could not confirm is stated in the result, also when the
  // run passed or stopped early. The step results and `status` are not changed by this.
  try {
    await finalLookups();
  } catch (e) {
    console.error(`final lookups stopped: ${String(e?.message ?? e).slice(0, 200)}`);
  }
  try {
    const sent = receipts.steps.flatMap((s) => s.txs).filter((rec) => !faucetRecs.has(rec));
    const u = unresolvedSummary(sent);
    receipts.unresolved_txs = u.count;
    receipts.unresolved_hashes = u.hashes;
    receipts.unresolved_note = u.note;
  } catch (e) {
    console.error(`could not count the unresolved transactions: ${String(e?.message ?? e).slice(0, 200)}`);
  }
  try {
    await writeOutputs();
  } catch (e) {
    console.error(`could not write the output files: ${e.message}`);
    exitCode = 1;
  }
}
for (const s of receipts.steps) console.log(`${s.ok ? 'PASS' : 'FAIL'} step ${s.n}: ${s.title}`);
console.log(`result: ${receipts.status}${receipts.unresolved_txs > 0 ? `, unresolved transactions (sent, outcome unknown): ${receipts.unresolved_txs}` : ''}; token ${deployment.token_account ?? '-'}`);
if (receipts.unresolved_note) console.log(receipts.unresolved_note);
process.exit(exitCode);
