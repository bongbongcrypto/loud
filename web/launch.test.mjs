// node --test web/launch.test.mjs  (no network)
import test from 'node:test';
import assert from 'node:assert/strict';
import * as chain from './chain.js';
import {
  validateForm, presetForm, PRESETS, matchingPreset, durationSeconds, secondsToDuration, contractCheck, BOUNDS,
  tokenAccountId, tokenLabel, randomSuffix, isNamedAccount, launchCost, launchActions, sendLaunch, classifyLaunch,
  paramMismatches, launchChecks, verifyLaunch, resultView, costView, openHref, parseWallets, serializeWallets, addWallet,
  parseLaunches, upsertLaunch, createLaunchMock, mockWasm, checkWasm, paramsSummary, NEAR, TGAS, SEC_NS, TOTAL_SUPPLY,
  NAME_ERROR, SYMBOL_ERROR, WALLET_KEY, FEE_RESERVE,
} from './launch.js';

const W = 'loud-try-mwg2oscv1a2b3c.testnet';
const form = (over = {}) => ({ ...presetForm('quick'), ...over });

test('presets produce the parameters they describe', () => {
  const std = validateForm(presetForm('standard'), W);
  assert.equal(std.ok, true);
  assert.deepEqual(std.params, {
    total_supply: (10n ** 27n).toString(),
    creator: W,
    creator_alloc_bps: 500,
    virtual_near: (100n * NEAR).toString(),
    loud_window_ns: (600n * SEC_NS).toString(),
    notice_ns: (1800n * SEC_NS).toString(),
    exit_window_ns: (3600n * SEC_NS).toString(),
    cap_bps: 50,
    cap_window_ns: (3600n * SEC_NS).toString(),
    name: 'My loud token',
    symbol: 'MINE',
    icon: null,
  });
  const q = validateForm(presetForm('quick'), W).params;
  assert.equal(q.loud_window_ns, (300n * SEC_NS).toString());
  assert.equal(q.notice_ns, (60n * SEC_NS).toString());
  assert.equal(q.exit_window_ns, (600n * SEC_NS).toString());
  assert.equal(q.cap_window_ns, (300n * SEC_NS).toString());
  assert.equal(q.cap_bps, 50);
  assert.equal(q.creator_alloc_bps, 0);
  const l = validateForm(presetForm('long'), W).params;
  assert.equal(l.loud_window_ns, (7n * 86400n * SEC_NS).toString());
  assert.equal(l.notice_ns, (60n * SEC_NS).toString());
  for (const k of Object.keys(PRESETS)) assert.equal(matchingPreset(presetForm(k)), k);
  assert.equal(matchingPreset(form({ capPct: '0.6' })), null);
  // Same value in another unit still matches.
  assert.equal(matchingPreset(form({ notice: ['60', 's'] })), 'quick');
});

test('bounds: the contract message at each edge', () => {
  const ok = (over) => assert.equal(validateForm(form(over), W).ok, true, JSON.stringify(over));
  const bad = (over, key, msg) => {
    const v = validateForm(form(over), W);
    assert.equal(v.ok, false);
    assert.equal(v.errors[key], msg);
  };
  ok({ creatorPct: '0' });
  ok({ creatorPct: '20' });
  bad({ creatorPct: '20.01' }, 'creatorPct', BOUNDS.creator_alloc_bps.error);
  bad({ creatorPct: '0.001' }, 'creatorPct', 'At most 2 decimal places (0.01%).');
  ok({ virtualNear: '0.1' });
  ok({ virtualNear: '1000000' });
  bad({ virtualNear: '0.099999' }, 'virtualNear', BOUNDS.virtual_near.error);
  bad({ virtualNear: '1000000.000001' }, 'virtualNear', BOUNDS.virtual_near.error);
  bad({ virtualNear: 'lots' }, 'virtualNear', 'Enter a number, for example 10 or 2.5.');
  ok({ loudWindow: ['60', 's'] });
  bad({ loudWindow: ['59', 's'] }, 'loudWindow', 'E_PARAMS: loud_window_ns must be 60 s ..= 7 days');
  ok({ loudWindow: ['7', 'd'] });
  bad({ loudWindow: ['7.01', 'd'] }, 'loudWindow', 'E_PARAMS: loud_window_ns must be 60 s ..= 7 days');
  ok({ notice: ['30', 's'] });
  bad({ notice: ['29', 's'] }, 'notice', 'E_PARAMS: notice_ns must be 30 s ..= 7 days');
  ok({ notice: ['0.5', 'min'] }); // 30 s
  bad({ notice: ['168.5', 'h'] }, 'notice', 'E_PARAMS: notice_ns must be 30 s ..= 7 days');
  bad({ exitWindow: ['0.5', 'min'] }, 'exitWindow', 'E_PARAMS: exit_window_ns must be 60 s ..= 7 days');
  ok({ capPct: '0.01' });
  ok({ capPct: '10' });
  bad({ capPct: '0' }, 'capPct', 'E_PARAMS: cap_bps must be 1 ..= 1000');
  bad({ capPct: '10.01' }, 'capPct', 'E_PARAMS: cap_bps must be 1 ..= 1000');
  bad({ capWindow: ['8', 'd'] }, 'capWindow', 'E_PARAMS: cap_window_ns must be 60 s ..= 7 days');
  bad({ capWindow: ['1.0001', 'min'] }, 'capWindow', 'Enter a number, for example 10 or 2.5.');
  bad({ notice: ['1.5', 's'] }, 'notice', 'Use whole seconds.');
});

test('name and symbol are limited in UTF-8 bytes', () => {
  assert.equal(validateForm(form({ name: 'n'.repeat(64) }), W).ok, true);
  assert.equal(validateForm(form({ name: 'n'.repeat(65) }), W).errors.name, NAME_ERROR);
  assert.equal(validateForm(form({ name: 'é'.repeat(32) }), W).ok, true); // 64 bytes
  assert.equal(validateForm(form({ name: 'é'.repeat(33) }), W).errors.name, NAME_ERROR); // 66 bytes
  assert.equal(validateForm(form({ symbol: 'S'.repeat(16) }), W).ok, true);
  assert.equal(validateForm(form({ symbol: 'S'.repeat(17) }), W).errors.symbol, SYMBOL_ERROR);
  assert.equal(validateForm(form({ symbol: 'é'.repeat(9) }), W).errors.symbol, SYMBOL_ERROR);
  assert.equal(validateForm(form({ name: '  ' }), W).errors.name, 'Enter a name.');
  assert.equal(validateForm(form({ name: '  Doge  ' }), W).params.name, 'Doge');
});

test('contractCheck follows the contract order', () => {
  const p = validateForm(form(), W).params;
  assert.equal(contractCheck(p), null);
  assert.equal(contractCheck({ ...p, total_supply: '1' }), 'E_PARAMS: total_supply must be 10^24 ..= 10^30 units');
  assert.equal(contractCheck({ ...p, cap_bps: 0, notice_ns: '1' }), 'E_PARAMS: notice_ns must be 30 s ..= 7 days');
  assert.equal(contractCheck({ ...p, creator: 'x.testnet' }, 'x.testnet'), 'E_PARAMS: creator cannot be the token account');
});

test('durations', () => {
  assert.equal(durationSeconds(['5', 'min']), 300n);
  assert.equal(durationSeconds(['1.5', 'h']), 5400n);
  assert.throws(() => durationSeconds(['abc', 'min']), /Enter a number/);
  assert.throws(() => durationSeconds(['5', 'weeks']), /unit/);
  assert.deepEqual(secondsToDuration(604800n), ['7', 'd']);
  assert.deepEqual(secondsToDuration(5400n), ['90', 'min']);
  assert.deepEqual(secondsToDuration(45n), ['45', 's']);
});

test('token account id', () => {
  assert.equal(tokenLabel('MINE'), 'mine');
  assert.equal(tokenLabel('$Do-ge!'), 'doge');
  assert.equal(tokenLabel('éé'), 'loud');
  assert.equal(tokenLabel('ABCDEFGHIJKLMNOP'), 'abcdefghijkl');
  assert.equal(tokenAccountId('MINE', W, 'k3x9'), `mine-k3x9.${W}`);
  assert.ok(isNamedAccount(tokenAccountId('MINE', W, 'k3x9')));
  // A long parent shortens the label to stay within 64 characters.
  const long = `${'a'.repeat(40)}.testnet`; // 48
  const id = tokenAccountId('ABCDEFGHIJKL', long, 'zz99');
  assert.equal(id.length, 64);
  assert.equal(id, `abcdefghij-zz99.${long}`);
  assert.throws(() => tokenAccountId('MINE', `${'a'.repeat(52)}.testnet`, 'zz99'), /too long/);
  assert.throws(() => tokenAccountId('MINE', 'f'.repeat(64), 'zz99'), /not a named NEAR account/);
  const s = randomSuffix(() => Uint8Array.of(0, 25, 26, 71));
  assert.equal(s, 'az09');
  assert.match(randomSuffix(), /^[a-z0-9]{4}$/);
});

test('deposit is sized like the deploy scripts: code bytes at 10^19 + 0.5 NEAR', () => {
  const c = launchCost(238_218);
  assert.equal(c.code, 238_218n * 10n ** 19n);
  assert.equal(c.deposit, 238_218n * 10n ** 19n + NEAR / 2n);
  assert.equal(c.total, c.deposit + FEE_RESERVE);
  assert.equal(c.deposit, 2_882_180_000_000_000_000_000_000n);
  const v = costView(c, 10n * NEAR);
  assert.equal(v.enough, true);
  assert.equal(v.rows.find((r) => r[0] === 'Deposit to the token account')[1], '2.88218 NEAR');
  assert.equal(v.rows.find((r) => r[0] === 'Launch needs')[1], '2.93218 NEAR');
  assert.equal(costView(c, 2n * NEAR).enough, false);
  assert.equal(costView(c, null).enough, null);
});

test('the launch transaction: four actions, no AddKey, encodable by chain.js', async () => {
  const { wasm } = await mockWasm(chain, 4096);
  const params = validateForm(form(), W).params;
  const deposit = launchCost(wasm.length).deposit;
  const actions = launchActions(chain, { wasm, params, deposit });
  assert.deepEqual(actions.map((a) => a.type), ['CreateAccount', 'Transfer', 'DeployContract', 'FunctionCall']);
  assert.equal(actions[1].deposit, deposit);
  assert.equal(actions[2].code, wasm);
  assert.equal(actions[3].method, 'new');
  assert.equal(actions[3].gas, 100n * TGAS);
  assert.equal(BigInt(actions[3].deposit), 0n);
  assert.deepEqual(actions[3].args, params);
  assert.ok(!actions.some((a) => a.type === 'AddKey'));
  // The same objects encode with chain.js (DeployContract tag 1 + u32 length + code).
  if (chain.deployContract) {
    const enc = chain.encodeAction(actions[2]);
    assert.equal(enc[0], 1);
    assert.equal(enc.length, 1 + 4 + wasm.length);
  }
  // sendLaunch hands them to sendActions with the longer confirm wait.
  const calls = [];
  const fake = { ...chain, sendActions: async (...a) => { calls.push(a); return { ok: true, outcome: 'success', hash: 'h' }; } };
  const wallet = { accountId: W, publicKey: 'ed25519:x', secretKey: 'y' };
  const tokenId = tokenAccountId('MINE', W, 'ab12');
  await sendLaunch(fake, { wallet, tokenId, wasm, params, deposit });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], wallet);
  assert.equal(calls[0][1], tokenId);
  assert.deepEqual(calls[0][2].map((a) => a.type), ['CreateAccount', 'Transfer', 'DeployContract', 'FunctionCall']);
  assert.equal(calls[0][3].confirmMs, 180_000);
});

test('classify results', () => {
  assert.equal(classifyLaunch({ ok: true, outcome: 'success' }).kind, 'success');
  const rej = classifyLaunch({ ok: false, outcome: 'failure', errorCode: 'E_PARAMS', errorMessage: 'E_PARAMS: notice_ns must be 30 s ..= 7 days' });
  assert.deepEqual([rej.kind, rej.code], ['rejected', 'E_PARAMS']);
  const exists = classifyLaunch({ ok: false, outcome: 'failure', errorCode: null, errorMessage: '{"ActionError":{"index":0,"kind":{"AccountAlreadyExists":{"account_id":"x"}}}}' });
  assert.deepEqual([exists.kind, exists.code], ['rejected', 'AccountAlreadyExists']);
  assert.equal(classifyLaunch({ ok: false, outcome: 'invalid', errorMessage: '{"InvalidTxError":{"NotEnoughBalance":{}}}' }).kind, 'funds');
  assert.equal(classifyLaunch({ ok: false, outcome: 'failure', errorMessage: '{"ActionError":{"kind":{"LackBalanceForState":{}}}}' }).kind, 'funds');
  assert.equal(classifyLaunch({ ok: false, outcome: 'invalid', errorMessage: 'InvalidNonce' }).kind, 'refused');
  assert.equal(classifyLaunch({ ok: false, outcome: 'unknown', hash: 'h' }).kind, 'unknown');
});

test('checks from chain reads', () => {
  const params = validateForm(form(), W).params;
  const onchain = {
    ...Object.fromEntries(['total_supply', 'creator', 'creator_alloc_bps', 'virtual_near', 'loud_window_ns', 'notice_ns', 'exit_window_ns', 'cap_bps', 'cap_window_ns'].map((k) => [k, params[k]])),
    launch_ts: '1000', loud_until: (1000n + BigInt(params.loud_window_ns)).toString(), cap_units: ((TOTAL_SUPPLY * 50n) / 10000n).toString(), creator_alloc: '0',
  };
  const meta = { name: params.name, symbol: params.symbol };
  assert.deepEqual(paramMismatches(params, onchain, meta), []);
  assert.equal(paramMismatches(params, { ...onchain, notice_ns: '1' }, meta).length, 1);
  assert.equal(paramMismatches(params, onchain, { ...meta, symbol: 'X' }).length, 1);
  assert.equal(paramMismatches(params, { ...onchain, loud_until: '5' }, meta).length, 1);
  const good = { account: { amount: (3n * NEAR).toString(), code_hash: 'H' }, keys: [], params: onchain, meta };
  assert.ok(launchChecks(good, params, 'H').every((c) => c.ok));
  const keyed = launchChecks({ ...good, keys: [{ public_key: 'ed25519:k' }] }, params, 'H');
  assert.equal(keyed.find((c) => c.id === 'keys').ok, false);
  assert.equal(launchChecks(good, params, 'other').find((c) => c.id === 'code').ok, false);
  const none = launchChecks({ account: null, keys: null, params: null, meta: null }, params, 'H');
  assert.ok(none.every((c) => !c.ok));
});

test('result wording', () => {
  const tokenId = `mine-ab12.${W}`;
  const okChecks = [{ id: 'exists', ok: true }, { id: 'keys', ok: true }, { id: 'params', ok: true }, { id: 'code', ok: true }];
  const s = resultView({ cls: { kind: 'success' }, tokenId, symbol: 'MINE', checks: okChecks });
  assert.equal(s.tone, 'ok');
  assert.equal(s.open, `index.html?token=${tokenId}#try`);
  assert.equal(s.status, 'ok');
  const partial = resultView({ cls: { kind: 'success' }, tokenId, symbol: 'MINE', checks: okChecks.map((c, i) => ({ ...c, ok: i !== 1 })) });
  assert.equal(partial.status, 'checks');
  const late = resultView({ cls: { kind: 'unknown' }, tokenId, symbol: 'MINE', checks: okChecks });
  assert.equal(late.status, 'ok');
  assert.match(late.call, /found on chain/);
  const lost = resultView({ cls: { kind: 'unknown' }, tokenId, symbol: 'MINE', checks: okChecks.map((c) => ({ ...c, ok: false })) });
  assert.equal(lost.status, 'unknown');
  assert.equal(lost.open, null);
  const rej = resultView({ cls: { kind: 'rejected', code: 'E_PARAMS', message: 'E_PARAMS: cap_bps must be 1 ..= 1000' }, tokenId, symbol: 'MINE' });
  assert.equal(rej.call, 'Rejected: E_PARAMS');
  assert.match(rej.message, /cap_bps must be 1 \.\.= 1000/);
  assert.equal(resultView({ cls: { kind: 'funds', message: '' }, tokenId, symbol: 'MINE' }).call, 'Not enough NEAR');
  assert.equal(openHref('a.b.testnet'), 'index.html?token=a.b.testnet#try');
  assert.ok(paramsSummary(validateForm(presetForm('standard'), W).params).some((x) => /cap 0.5% of supply per 1 h/.test(x)));
});

test('wallet store and launch list', () => {
  const w1 = { accountId: 'a-1.testnet', publicKey: 'ed25519:p', secretKey: 'ed25519:s' };
  let s = parseWallets(serializeWallets(addWallet(parseWallets(null), w1)));
  assert.deepEqual(s, { wallets: [w1], active: 0 });
  assert.equal(WALLET_KEY, 'loud.live.wallets.v1');
  assert.deepEqual(parseWallets('nope'), { wallets: [], active: 0 });
  let list = upsertLaunch([], { token: `mine-ab12.${W}`, symbol: 'MINE', status: 'sent' });
  list = upsertLaunch(list, { token: `mine-ab12.${W}`, symbol: 'MINE', status: 'ok', tx: 'EtXJrzhZpkyZsXicUrnzMCeTe1V9E3v66jGGf7dT4kQg' });
  assert.equal(list.length, 1);
  assert.equal(list[0].status, 'ok');
  assert.deepEqual(parseLaunches(JSON.stringify(list)), list);
  assert.deepEqual(parseLaunches('{bad'), []);
  assert.deepEqual(parseLaunches(JSON.stringify([{ token: 'BAD ID' }])), []);
});

test('mock end to end: launch, verify, rejection, not enough NEAR, faucet refusal', async () => {
  const m = createLaunchMock();
  const wallet = await m.createTestWallet();
  const { wasm, meta } = await mockWasm(m);
  const chk = await checkWasm(m, wasm, meta);
  assert.equal(chk.ok, true);
  assert.equal((await checkWasm(m, wasm, { ...meta, sha256_hex: '00' })).ok, false);
  const params = validateForm(form(), wallet.accountId).params;
  const tokenId = tokenAccountId('MINE', wallet.accountId, 'ab12');
  const deposit = launchCost(wasm.length).deposit;
  const res = await sendLaunch(m, { wallet, tokenId, wasm, params, deposit });
  assert.equal(classifyLaunch(res).kind, 'success');
  const v = await verifyLaunch(m, tokenId, params, chk.codeHash, { tries: 1 });
  assert.equal(v.ok, true, JSON.stringify(v.checks));
  // The same id again: AccountAlreadyExists.
  const again = await sendLaunch(m, { wallet, tokenId, wasm, params, deposit });
  assert.equal(classifyLaunch(again).code, 'AccountAlreadyExists');
  // A contract rejection.
  const r = createLaunchMock({ reject: 'E_PARAMS: notice_ns must be 30 s ..= 7 days' });
  const w2 = await r.createTestWallet();
  const rr = classifyLaunch(await sendLaunch(r, { wallet: w2, tokenId: tokenAccountId('X', w2.accountId, 'aaaa'), wasm, params: { ...params, creator: w2.accountId }, deposit }));
  assert.deepEqual([rr.kind, rr.code], ['rejected', 'E_PARAMS']);
  // Not enough NEAR.
  const p = createLaunchMock({ startNear: 2n });
  const w3 = await p.createTestWallet();
  assert.equal(classifyLaunch(await sendLaunch(p, { wallet: w3, tokenId: tokenAccountId('X', w3.accountId, 'aaaa'), wasm, params, deposit })).kind, 'funds');
  // Faucet refusal keeps its message.
  await assert.rejects(createLaunchMock({ faucetFails: true }).createTestWallet(), /Too many requests/);
});
