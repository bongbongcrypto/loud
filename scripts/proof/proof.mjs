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
} from './lib.mjs';

const { KeyPair, transactions: T, utils } = nearApi;
const { base_encode: b58encode, base_decode: b58decode } = utils.serialize;

// ---------- configuration ----------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const WEB_DIR = path.join(REPO, 'web');
const env = process.env;
const list = (v) => v.split(',').map((s) => s.trim()).filter(Boolean);

const PRESET = env.PRESET || 'demo';
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

// ---------- output documents ----------

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
  },
  error: null,
  generated_at: null,
};

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

// What a transaction looks like inside receipts.json.
function txRecord(r, extra = {}) {
  return { hash: r.hash, account: r.account, outcome: r.outcome, error: r.error, ...extra };
}

// Record of a call that pays NEAR when it succeeds (sell, leave). `settled` is true only
// when every receipt outcome of the transaction succeeded; it is null when the call
// itself did not succeed, because then nothing was due.
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

// ---------- accounts and transactions ----------

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
async function sendTx(signer, receiverId, actions) {
  let hash = null;
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
      return summarize(result, hash, signer.id);
    } catch (e) {
      const text = e instanceof RpcError ? e.text : String(e?.message ?? e);
      if (e instanceof RpcError && /InvalidNonce|Expired/.test(text) && attempt < 2) {
        signer.nonce = null;
        recentBlock = { promise: null, at: 0 };
        continue;
      }
      // Only a transaction the node refused is "invalid"; anything else is not known to have failed.
      const invalid = e instanceof RpcError && (e.cause_ === 'INVALID_TRANSACTION' || e.rpcName === 'REQUEST_VALIDATION_ERROR');
      return {
        hash, account: signer.id, outcome: invalid ? 'invalid' : 'unknown',
        error: text.slice(0, 400), code: errorCode(text), logs: [], successValue: null, blockHash: null,
        settled: false, receiptsFailed: 0, receiptError: null,
      };
    }
  }
  throw new Error('unreachable');
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
    // All receipt outcomes, not only the top-level status: a detached payout that failed
    // shows only there.
    settled: settlement.settled,
    receiptsFailed: settlement.failed.length,
    receiptError: settlement.failed.length > 0
      ? `receipt ${settlement.failed[0].receipt_id ?? '?'} on ${settlement.failed[0].executor ?? '?'}: ${settlement.failed[0].error}`.slice(0, 400)
      : (settlement.receipts === 0 ? 'the result lists no receipt outcomes' : null),
  };
}

const call = (signer, contract, method, args, { gas = 30n * TGAS, deposit = 0n } = {}) =>
  sendTx(signer, contract, [T.functionCall(method, args, gas, deposit)]);

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

// ---------- the run ----------

async function main() {
  log(`preset ${PRESET}; rpc ${RPC_URLS.map((u) => new URL(u).host).join(', ')}`);
  presetParams(PRESET, 'check.testnet'); // reject an unsupported preset before any account is created
  const wasm = new Uint8Array(await readFile(WASM_PATH));
  if (wasm.length < 1000 || wasm.length > MAX_TX_BYTES - 2000) throw new Error(`unexpected wasm size: ${wasm.length} bytes`);
  deployment.wasm = { bytes: wasm.length, sha256: createHash('sha256').update(wasm).digest('hex') };
  log(`wasm ${wasm.length} bytes, sha256 ${deployment.wasm.sha256}`);

  // ----- step 1: root account from the faucet -----
  const s1 = addStep(1, 'Create a fresh root account through the testnet faucet', 'the account exists and is funded');
  const root = newSigner(`loud-${Date.now().toString(36)}${randomBytes(3).toString('hex')}.testnet`);
  deployment.root_account = root.id;
  deployment.explorer.root = accountLink(root.id);
  const faucet = await faucetCreate(root);
  if (faucet.tx) s1.txs.push(faucet.tx);
  let rootBalance = await balanceOf(root.id);
  let plan = budget({ wasmBytes: wasm.length, balance: rootBalance, wallets: WALLETS });
  // Top-up: if one faucet grant is too small, create up to three more faucet accounts and
  // delete each with the root as beneficiary, which moves its balance to the root.
  for (let i = 1; i <= 3 && !plan.ok; i++) {
    log(`root has ${yoctoToNear(rootBalance)} NEAR, needs ${yoctoToNear(plan.need)}; top-up ${i}`);
    const extra = newSigner(root.id.replace('.testnet', `f${i}.testnet`));
    try {
      const extraFaucet = await faucetCreate(extra);
      if (extraFaucet.tx) s1.txs.push(extraFaucet.tx);
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
  log(`plan: token ${yoctoToNear(plan.tokenDeposit)}, insider ${yoctoToNear(plan.insider)}, late ${yoctoToNear(plan.late)}, each wallet ${yoctoToNear(plan.perWallet)} NEAR`);

  // ----- step 3 (runs before step 2 so the loud window is not spent on setup) -----
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

  // ----- step 2: token account in one batch transaction, no AddKey -----
  const s2 = addStep(2, 'Create, fund, deploy and initialise the token account in one transaction with no access key',
    'view_access_key_list returns an empty list; the on-chain code hash equals the hash of the built wasm; get_params equals the preset');
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
  const onchain = await view('get_params');
  deployment.onchain_params = onchain;
  const mismatches = paramMismatches(params, onchain);
  deployment.param_mismatches = mismatches;
  deployment.params_match = mismatches.length === 0;
  const deployOk = deployment.zero_keys && deployment.code_hash_match && deployment.params_match;
  finishStep(s2, deployOk,
    `${token} has ${keys.length} access keys; code hash on chain ${deployment.code_hash} `
    + `${deployment.code_hash_match ? 'equals' : 'DIFFERS from'} the hash of the built wasm ${expectedCodeHash}; `
    + (deployment.params_match
      ? `get_params equals the ${PRESET} preset (cap_units ${unitsToTokens(onchain.cap_units)} LOUD per ${BigInt(onchain.cap_window_ns) / 10n ** 9n}s)`
      : `get_params differs from the ${PRESET} preset: ${mismatches.join('; ').slice(0, 500)}`));
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

  // ----- step 4: insider buys in the loud window -----
  const s4 = addStep(4, 'The insider buys with 1 NEAR during the loud window', 'the bought tokens are loud; quiet balance is 0');
  const before4 = await account(insider.id);
  const buy = await call(insider, token, 'buy', { min_tokens_out: '1' }, { gas: 50n * TGAS, deposit: nearToYocto('1') });
  s4.txs.push(txRecord(buy));
  const bought = returnValueBigInt(buy.successValue) ?? 0n;
  const after4 = await readUntil(() => account(insider.id), (a) => buy.outcome !== 'success' || BigInt(a.loud) > BigInt(before4.loud));
  const insiderLoud = BigInt(after4.loud);
  finishStep(s4, buy.outcome === 'success' && insiderLoud > BigInt(before4.loud) && BigInt(after4.quiet) === 0n,
    `loud ${unitsToTokens(before4.loud)} -> ${unitsToTokens(insiderLoud)} LOUD (bought ${unitsToTokens(bought)}), quiet ${after4.quiet}${buy.error ? `; ${buy.error}` : ''}`);
  if (insiderLoud === 0n) throw new Error('the insider holds no loud tokens; nothing to split');

  // ----- step 5: split across the wallets -----
  const s5 = addStep(5, `The insider splits its whole loud balance across ${WALLETS} wallets with ft_transfer`,
    `every wallet holds loud tokens and no quiet tokens; the insider holds 0`);
  const parts = splitEvenly(insiderLoud, WALLETS);
  for (let i = 0; i < WALLETS; i++) {
    checkDeadline('splitting');
    const r = await call(insider, token, 'ft_transfer', { receiver_id: wallets[i].id, amount: parts[i].toString() }, { deposit: ONE_YOCTO });
    s5.txs.push(txRecord(r));
    if (r.outcome !== 'success') log(`ft_transfer to ${wallets[i].id}: ${r.outcome} ${r.error}`);
  }
  await readUntil(() => account(wallets[WALLETS - 1].id), (a) => BigInt(a.loud) === parts[WALLETS - 1]);
  const balances = await Promise.all(wallets.map((w) => account(w.id)));
  const insiderAfter = await account(insider.id);
  s5.balances = wallets.map((w, i) => ({ account: w.id, loud: String(balances[i].loud), quiet: String(balances[i].quiet) }));
  const loudOk = balances.every((b, i) => BigInt(b.loud) === parts[i] && BigInt(b.quiet) === 0n);
  finishStep(s5, loudOk && BigInt(insiderAfter.loud) === 0n,
    `${balances.filter((b) => BigInt(b.loud) > 0n).length} wallets hold loud, about ${unitsToTokens(parts[0])} LOUD each; insider loud ${insiderAfter.loud}`);

  // ----- step 6: a split wallet cannot use sell() -----
  const s6 = addStep(6, 'A split wallet tries sell() with its loud tokens', 'the call fails with E_NO_QUIET');
  const sellTry = await call(wallets[0], token, 'sell', { amount: parts[0].toString(), min_near_out: '0' }, { gas: 50n * TGAS, deposit: ONE_YOCTO });
  s6.txs.push(txRecord(sellTry));
  finishStep(s6, sellTry.outcome === 'failure' && sellTry.code === 'E_NO_QUIET', `${sellTry.outcome}: ${sellTry.error ?? 'no error'}`);

  // ----- step 7: a late buyer stays quiet and can sell at once -----
  const s7 = addStep(7, 'After the loud window a late buyer buys with 0.5 NEAR and sells half at once',
    'the late buyer holds quiet tokens only; the sell succeeds and none of its receipts failed');
  await waitChainTime(loudUntil + 1n, 'the end of the loud window');
  const lateBuy = await call(late, token, 'buy', { min_tokens_out: '1' }, { gas: 50n * TGAS, deposit: nearToYocto('0.5') });
  s7.txs.push(txRecord(lateBuy));
  const lateAfterBuy = await readUntil(() => account(late.id), (a) => lateBuy.outcome !== 'success' || BigInt(a.quiet) > 0n);
  const lateQuiet = BigInt(lateAfterBuy.quiet);
  let lateSell = null;
  if (lateQuiet > 1n) {
    lateSell = await call(late, token, 'sell', { amount: (lateQuiet / 2n).toString(), min_near_out: '0' }, { gas: 50n * TGAS, deposit: ONE_YOCTO });
    s7.txs.push(payRecord(lateSell));
  }
  const sellSettled = lateSell?.outcome === 'success' && lateSell.settled === true;
  s7.payout_calls = lateSell?.outcome === 'success' ? 1 : 0;
  s7.payouts_settled = sellSettled ? 1 : 0;
  finishStep(s7, lateBuy.outcome === 'success' && BigInt(lateAfterBuy.loud) === 0n && lateQuiet > 0n && sellSettled,
    `after buy: loud ${lateAfterBuy.loud}, quiet ${unitsToTokens(lateQuiet)} LOUD; sell of half: ${lateSell ? lateSell.outcome : 'not sent'}${lateSell?.error ? ` (${lateSell.error})` : ''}`
    + (lateSell?.outcome === 'success' ? `; payout receipts: ${sellSettled ? 'all succeeded' : `NOT settled (${lateSell.receiptError ?? 'unknown'})`}` : ''));

  // ----- step 8: every wallet shouts; an early leave is rejected -----
  const s8 = addStep(8, `All ${WALLETS} wallets shout their full balance; one tries leave() before the notice ends`,
    `${WALLETS} open exits; the early leave fails with E_NOTICE`);
  const shouts = await Promise.all(wallets.map((w, i) => call(w, token, 'shout', { amount: parts[i].toString() }, { deposit: ONE_YOCTO })));
  shouts.forEach((r) => s8.txs.push(txRecord(r)));
  // The early leave goes out at once, while the notice of the exit just opened is still running.
  let early = null;
  const firstShout = shouts.findIndex((r) => r.outcome === 'success' && returnValueBigInt(r.successValue) !== null);
  if (firstShout >= 0) {
    early = await call(wallets[firstShout], token, 'leave',
      { exit_id: returnValueBigInt(shouts[firstShout].successValue).toString(), min_near_out: '0' }, { gas: 50n * TGAS, deposit: ONE_YOCTO });
    s8.txs.push(txRecord(early));
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
    const e = open[0];
    early = await call(e.wallet, token, 'leave', { exit_id: e.id, min_near_out: '0' }, { gas: 50n * TGAS, deposit: ONE_YOCTO });
    s8.txs.push(txRecord(early));
  }
  finishStep(s8, open.length === WALLETS && early?.outcome === 'failure' && early.code === 'E_NOTICE',
    `${open.length} open exits (ids ${open.map((e) => e.id).join(',')}); early leave: ${early ? `${early.outcome}: ${early.error ?? 'no error'}` : 'not sent'}`);
  if (open.length === 0) throw new Error('no exit was opened; cannot run the leave test');

  // ----- step 9: all wallets leave for one cap window -----
  const s9 = addStep(9, `After the notice, all ${WALLETS} wallets call leave() in rounds for one full cap window`,
    'at least one fill; every rejected call fails with E_CAP (or E_EXPIRED at the very end); no successful leave has a failed receipt');
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
    const r = await call(e.wallet, token, 'leave', { exit_id: e.id, min_near_out: '0' }, { gas: 50n * TGAS, deposit: ONE_YOCTO });
    const { remaining, fields } = await leaveFields(r);
    // A successful leave pays NEAR, so the record carries `settled` (all receipts succeeded).
    const rec = payRecord(r, { round, exit_id: e.id, ...fields });
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

  // One more look at calls whose result no endpoint confirmed and at fills without a block
  // time: step 10 needs every fill on record with its time, or it fails.
  for (const p of trail) {
    const { rec } = p;
    if (Date.now() - startedAt > MAX_RUNTIME_MS) break;
    if (rec.outcome === 'unknown' && rec.hash) {
      try {
        const result = await rpc.call('tx', { tx_hash: rec.hash, sender_account_id: p.e.wallet.id, wait_until: 'FINAL' }, { tries: 3 });
        const r = summarize(result, rec.hash, p.e.wallet.id);
        const { fields } = await leaveFields(r);
        Object.assign(rec, payRecord(r, { round: rec.round, exit_id: rec.exit_id, ...fields }));
        p.blockHash = r.blockHash;
        log(`leave ${rec.hash} was confirmed on a second look: ${rec.outcome}`);
      } catch (e) {
        log(`leave ${rec.hash} is still unconfirmed: ${String(e?.message ?? e).slice(0, 160)}`);
      }
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

  const fillsCount = attempts.filter((a) => a.filled !== null && BigInt(a.filled) > 0n).length;
  const capHits = attempts.filter((a) => a.error_code === 'E_CAP').length;
  // Only an executed call that failed for another reason counts as an unexpected failure.
  // "invalid" and "unknown" calls are listed as not executed; if one of them did change the
  // contract counter, step 10 fails because the receipts no longer match the counter.
  const unexpected = attempts.filter((a) => a.outcome === 'failure' && a.error_code !== 'E_CAP' && a.error_code !== 'E_EXPIRED').length;
  const payoutCalls = attempts.filter((a) => a.outcome === 'success').length;
  const payoutsSettled = attempts.filter((a) => a.outcome === 'success' && a.settled === true).length;
  s9.payout_calls = payoutCalls;
  s9.payouts_settled = payoutsSettled;
  receipts.split.attempts = attempts.length;
  receipts.split.cap_hits = capHits;
  receipts.split.payout_calls = payoutCalls;
  receipts.split.payouts_settled = payoutsSettled;
  finishStep(s9, fillsCount > 0 && unexpected === 0 && payoutsSettled === payoutCalls,
    `${attempts.length} leave calls from ${open.length} wallets: ${fillsCount} filled, ${capHits} E_CAP, ${attempts.filter((a) => a.error_code === 'E_EXPIRED').length} E_EXPIRED, ${unexpected} other failures, ${attempts.filter((a) => a.outcome === 'invalid' || a.outcome === 'unknown').length} not executed; `
    + `${payoutsSettled} of ${payoutCalls} successful leaves have no failed receipt`);

  // ----- step 10: the cap held -----
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
    + (reasons.length > 0 ? `; not passed because: ${reasons.join('; ').slice(0, 600)}` : ''));
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
  try {
    await writeOutputs();
  } catch (e) {
    console.error(`could not write the output files: ${e.message}`);
    exitCode = 1;
  }
}
for (const s of receipts.steps) console.log(`${s.ok ? 'PASS' : 'FAIL'} step ${s.n}: ${s.title}`);
console.log(`result: ${receipts.status}; token ${deployment.token_account ?? '-'}`);
process.exit(exitCode);
