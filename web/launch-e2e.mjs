// On-chain check of the launch page's path, with the page's own code (launch.js and
// chain.js): one faucet wallet launches a token with the "Try in 5 minutes" preset, the
// four checks are read from NEAR testnet, and the wallet buys once inside the launch
// window. Prints one JSON line per step; exits non-zero when a step does not hold.
//
//   node web/launch-e2e.mjs        (Node 22, no install; needs web/loud.wasm)
//
// Run by .github/workflows/launch-e2e.yml. The faucet limits accounts per network
// address, so this runs from a CI runner.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as chain from './chain.js';
import {
  presetForm, validateForm, tokenAccountId, randomSuffix, launchCost, sendLaunch, classifyLaunch, verifyLaunch,
  checkWasm, NEAR,
} from './launch.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let failed = false;
const line = (step, ok, data = {}) => {
  if (!ok) failed = true;
  console.log(JSON.stringify({ step, ok, ...data }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
};

async function main() {
  const wasm = new Uint8Array(await readFile(path.join(here, 'loud.wasm')));
  const meta = JSON.parse(await readFile(path.join(here, 'loud.wasm.json'), 'utf8'));
  const w = await checkWasm(chain, wasm, meta);
  line('wasm', w.ok, { bytes: wasm.length, code_hash: w.codeHash, commit: meta.commit });
  if (!w.ok) return;

  let wallet;
  try {
    wallet = await chain.createTestWallet({ prefix: 'loud-launch' });
  } catch (e) {
    line('wallet', false, { error: String(e.message).slice(0, 400), status: e.status ?? null });
    return;
  }
  const bal = BigInt((await chain.accountState(wallet.accountId)).amountYocto);
  line('wallet', true, { account: wallet.accountId, near: bal });

  const form = presetForm('quick', { name: 'Launch check', symbol: 'LCHK' });
  const v = validateForm(form, wallet.accountId);
  if (!v.ok) {
    line('params', false, { errors: v.errors });
    return;
  }
  const tokenId = tokenAccountId(form.symbol, wallet.accountId, randomSuffix());
  const cost = launchCost(wasm.length);
  line('plan', bal >= cost.total, { token: tokenId, deposit: cost.deposit, needs: cost.total, params: v.params });
  if (bal < cost.total) return;

  const started = Date.now();
  const res = await sendLaunch(chain, { wallet, tokenId, wasm, params: v.params, deposit: cost.deposit });
  const cls = classifyLaunch(res);
  line('launch', cls.kind === 'success', {
    outcome: res.outcome, kind: cls.kind, code: cls.code, error: res.errorMessage, hash: res.hash, explorer: res.explorerUrl, seconds: Math.round((Date.now() - started) / 1000),
  });
  if (cls.kind !== 'success' && cls.kind !== 'unknown') return;

  const checks = await verifyLaunch(chain, tokenId, v.params, w.codeHash, { tries: 15, waitMs: 2000 });
  for (const c of checks.checks) line(`check:${c.id}`, c.ok, { label: c.label, detail: c.detail });
  if (!checks.ok) return;

  const buy = await chain.call(wallet, tokenId, 'buy', { min_tokens_out: '1' }, { gasTgas: 50, depositYocto: (NEAR / 2n).toString() });
  const ev = (buy.events ?? []).find((e) => e.standard === 'loud' && e.event === 'buy');
  line('buy', buy.ok && !!ev && ev.data.loud === true, { hash: buy.hash, explorer: buy.explorerUrl, error: buy.errorMessage, event: ev?.data ?? null });
  if (!buy.ok) return;
  const acct = await chain.view(tokenId, 'get_account', { account_id: wallet.accountId });
  line('balance', BigInt(acct.loud) > 0n, { loud: acct.loud, quiet: acct.quiet });
  line('open', true, { href: `https://bongbongcrypto.github.io/loud/index.html?token=${tokenId}#try` });
}

try {
  await main();
} catch (e) {
  line('stopped', false, { error: String(e?.stack ?? e).slice(0, 600) });
}
process.exit(failed ? 1 : 0);
