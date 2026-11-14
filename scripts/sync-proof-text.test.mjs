import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncFiles, syncHtml, syncReadme, CHECK_TEXT, CHECK_TEXT_CATCH } from './sync-proof-text.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, 'scripts', 'sync-proof-text.mjs');

// A copy of the page, its tests and the README in a temporary directory.
function copyRepo(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'proof-text-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'web'));
  cpSync(path.join(REPO, 'web'), path.join(root, 'web'), { recursive: true });
  cpSync(path.join(REPO, 'README.md'), path.join(root, 'README.md'));
  return root;
}

const read = (root, rel) => readFileSync(path.join(root, ...rel.split('/')), 'utf8');
function put(root, deployment, receipts) {
  writeFileSync(path.join(root, 'web', 'deployment.json'), `${JSON.stringify(deployment, null, 2)}\n`);
  writeFileSync(path.join(root, 'web', 'receipts.json'), `${JSON.stringify(receipts, null, 2)}\n`);
}

// The page's own tests of its static text, run on the copy.
function pageTests(root) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // set inside a test run; a child that inherits it reports nothing
  return spawnSync(process.execPath, ['--test', '--test-name-pattern', '^index\\.html: ', path.join(root, 'web', 'ui-logic.test.mjs')], { env, encoding: 'utf8' });
}
function assertPagePasses(root) {
  const run = pageTests(root);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /the proof lines readable without the page script are the recorded run/);
  assert.match(run.stdout, /\bfail 0\b/);
}
const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

// The two files as scripts/proof/proof.mjs writes them: every key present from the start.
const H = (c) => c.repeat(44);
const UNITS = (n) => String(BigInt(n) * 10n ** 18n);
const ROOT_ACCOUNT = 'loud-zz99.testnet';
const TOKEN = `t.${ROOT_ACCOUNT}`;
const NEAR_READING = {
  balance: '8000000000000000000000000', pool_near: '5000000000000000000000000', owed_total: '0',
  spare: '3000000000000000000000000', storage_bytes: 230000, storage_stake: '2300000000000000000000000', free: '700000000000000000000000',
};

function deploymentFile(over = {}) {
  return {
    status: 'ok', network: 'testnet', preset: 'demo',
    token_account: TOKEN, root_account: ROOT_ACCOUNT, creator_account: `insider.${ROOT_ACCOUNT}`,
    params: {}, onchain_params: {}, deployed_at: '2027-01-02T03:04:05.000Z', deployed_at_ns: '1798859045000000000',
    tx: H('A'), zero_keys: true, access_keys: [], wasm: { bytes: 230000, sha256: 'cd'.repeat(32) },
    code_hash: H('B'), expected_code_hash: H('B'), code_hash_match: true, params_match: true, param_mismatches: [],
    explorer: {
      token: `https://testnet.nearblocks.io/address/${TOKEN}`,
      root: `https://testnet.nearblocks.io/address/${ROOT_ACCOUNT}`,
      tx: `https://testnet.nearblocks.io/txns/${H('A')}`,
    },
    run: { repository: 'someone/loud', run_id: '987654321', commit: '0123456789abcdef0123456789abcdef01234567' },
    generated_at: '2027-01-02T03:30:00.000Z',
    ...over,
  };
}

function receiptsFile(over = {}) {
  return {
    status: 'ok', network: 'testnet', token_account: TOKEN,
    accounts: { insider: `insider.${ROOT_ACCOUNT}`, late: `late.${ROOT_ACCOUNT}`, wallets: [] },
    steps: Array.from({ length: 10 }, (_, i) => ({
      n: i + 1, title: `Recorded title ${i + 1}`, ok: true, expect: `recorded expectation ${i + 1}`, got: 'as expected',
      txs: [{ hash: H('C'), account: `insider.${ROOT_ACCOUNT}`, outcome: 'success', error: null }],
    })),
    split: {
      wallets: 20, cap_units: UNITS(5_000_000), cap_window_ns: '600000000000', bucket_at_start: UNITS(400_000),
      window_start_ns: '1798860000000000000', window_end_ns: '1798860600000000000', measured_until_ns: '1798860612000000000',
      sold_in_window: UNITS(5_300_000), sold_total: UNITS(5_350_000), bound: UNITS(5_500_000),
      attempts: 240, fills: 80, cap_hits: 160, receipts_match_counter: true,
      measured_ns: '612000000000', full_window: true, timestamps_valid: true, payout_calls: 80, payouts_settled: 80,
      fail_reasons: null, pass: true, executed_failed: 160, not_executed: 0, unresolved: 0,
    },
    error: null,
    unresolved_txs: 0, unresolved_hashes: [], unresolved_note: null,
    token_near: { at_deploy: NEAR_READING, at_end: NEAR_READING },
    owed_total_at_end: '0',
    generated_at: '2027-01-02T03:30:00.000Z',
    ...over,
  };
}

test('the saved files: nothing to change', (t) => {
  const root = copyRepo(t);
  assert.deepEqual(syncFiles(root, { check: true }), []);
  assert.deepEqual(syncFiles(root), []);
  assert.equal(read(root, 'web/index.html'), read(REPO, 'web/index.html'));
  assert.equal(read(root, 'README.md'), read(REPO, 'README.md'));
});

test('a run of the current script: the text follows it, and a second pass changes nothing', (t) => {
  const root = copyRepo(t);
  put(root, deploymentFile(), receiptsFile());
  // The copy still holds the saved run, so the page's test fails on it before the sync.
  assert.notEqual(pageTests(root).status, 0);
  assert.deepEqual(syncFiles(root, { check: true }), ['web/index.html', 'README.md']);
  assert.equal(read(root, 'web/index.html'), read(REPO, 'web/index.html'));

  assert.deepEqual(syncFiles(root), ['web/index.html', 'README.md']);
  const html = read(root, 'web/index.html');
  const readme = read(root, 'README.md');
  assert.deepEqual(syncFiles(root), []);
  assert.equal(read(root, 'web/index.html'), html);
  assert.equal(read(root, 'README.md'), readme);
  assertPagePasses(root);

  assert.ok(html.includes(`<a href="https://testnet.nearblocks.io/address/${TOKEN}" rel="noopener">${TOKEN}</a>`));
  assert.ok(html.includes('<span>on NEAR testnet, 2027-01-02.</span>'));
  assert.ok(html.includes('<span id="proof-stamp">Recorded 2027-01-02T03:30:00.000Z.</span>'));
  // The current script writes token_near: both sentences about the later rules are gone.
  assert.ok(html.includes('<p class="fine" id="proof-scope" hidden></p>'));
  assert.ok(!html.includes('Recorded before two later rules'));
  assert.ok(!readme.includes('Two rules came after that commit'));
  assert.ok(readme.includes('.<!-- proof:scope --><!-- /proof:scope -->'));
  assert.ok(readme.includes(`[${TOKEN}](https://testnet.nearblocks.io/address/${TOKEN}), no access keys, demo preset, recorded 2027-01-02<!--`));
  assert.ok(readme.includes('built from commit `0123456`'));
  // The rows keep their short wording, not the titles of the data file.
  assert.ok(html.includes('<tr><td>6. One wallet tries a plain sell <span class="expect">'));
  assert.ok(!html.includes('Recorded title'));
  // No line ending other than LF is written.
  assert.ok(!html.includes('\r') && !readme.includes('\r'));

  // Back to the saved files: the saved text, byte for byte.
  put(root, JSON.parse(read(REPO, 'web/deployment.json')), JSON.parse(read(REPO, 'web/receipts.json')));
  syncFiles(root);
  assert.equal(read(root, 'web/index.html'), read(REPO, 'web/index.html'));
  assert.equal(read(root, 'README.md'), read(REPO, 'README.md'));
});

test('transactions with no confirmed outcome are said in the static text', (t) => {
  const root = copyRepo(t);
  const note = '2 transactions were sent and their outcome stayed unknown; the cap check rests on the contract counter & not on them.';
  put(root, deploymentFile(), receiptsFile({ unresolved_txs: 2, unresolved_hashes: [H('U'), H('V')], unresolved_note: note }));
  syncFiles(root);
  const html = read(root, 'web/index.html');
  assert.ok(html.includes('<span>on NEAR testnet, 2027-01-02. 2 transactions were sent with no confirmed outcome.</span>'));
  assert.ok(html.includes(`<p class="state" id="rec-state" data-state="ok">All 10 steps passed on NEAR testnet. ${note.replace('&', '&amp;')}</p>`));
  assertPagePasses(root);
  assert.deepEqual(syncFiles(root), []);
});

test('a run that failed at the cap check never reads as a pass', (t) => {
  const root = copyRepo(t);
  const rec = receiptsFile({ status: 'failed' });
  rec.steps[9].ok = false;
  rec.split = { ...rec.split, pass: false, sold_total: UNITS(6_000_000), fail_reasons: ['sold more than the bound'] };
  put(root, deploymentFile(), rec);
  syncFiles(root);
  const html = read(root, 'web/index.html');
  const readme = read(root, 'README.md');
  assert.ok(html.includes('<li data-state="failed"><b>9 of 10 checks passed</b>'));
  assert.ok(html.includes('<li data-state="failed"><b>20 wallets tried to dump. The cap check failed.</b>'));
  assert.ok(html.includes('id="split-proof-state" data-state="failed">FAIL. A group of 20 wallets sold 6,000,000 LOUD'));
  assert.ok(html.includes('<span class="expect">Expected: no more than the cap allows</span></td><td class="res" data-result="FAIL">FAIL</td></tr>'));
  assert.ok(html.includes('id="rec-state" data-state="failed">The run did not pass: 9 of 10 recorded steps passed.</p>'));
  assert.ok(readme.includes('recorded 2027-01-02, the last run did not pass<!--'));
  assertPagePasses(root);
  assert.deepEqual(syncFiles(root), []);
});

test('a run that stopped before the deploy: no token, no link, text from the file is escaped', (t) => {
  const root = copyRepo(t);
  const error = 'faucet answered <html> 502 & "retry" $& $1 later';
  const dep = deploymentFile({
    status: 'failed', token_account: null, root_account: null, creator_account: null, params: null, onchain_params: null,
    deployed_at: null, deployed_at_ns: null, tx: null, zero_keys: false, access_keys: null, wasm: null,
    code_hash: null, expected_code_hash: null, code_hash_match: null, params_match: null, param_mismatches: null,
    explorer: { token: null, root: null, tx: null },
  });
  const rec = receiptsFile({ status: 'failed', token_account: null, error, token_near: { at_deploy: null, at_end: null }, owed_total_at_end: null });
  rec.steps = [{ n: 1, title: 'Create a fresh root account through the testnet faucet', ok: false, expect: 'the account exists and is funded', got: null, txs: [] }];
  rec.split = { ...rec.split, cap_units: null, bucket_at_start: null, window_start_ns: null, window_end_ns: null, measured_until_ns: null,
    sold_in_window: null, sold_total: null, bound: null, attempts: 0, fills: 0, cap_hits: 0, receipts_match_counter: null, pass: false };
  put(root, dep, rec);
  syncFiles(root);
  const html = read(root, 'web/index.html');
  const readme = read(root, 'README.md');
  assert.ok(html.includes('<dd id="sum-token">Not deployed yet.</dd>'));
  assert.ok(!html.includes('href="null"') && !html.includes('href=""'));
  assert.ok(html.includes('faucet answered &lt;html&gt; 502 &amp; &quot;retry&quot; $&amp; $1 later'));
  assert.ok(!html.includes('<html> 502'));
  assert.ok(html.includes('id="split-proof-state" data-state="pending">No split measurement yet.</p>'));
  // One check was recorded: it is the only row, and the folded list is hidden.
  assert.equal(html.split('data-result="').length - 1, 1);
  assert.ok(html.includes('<details class="fine-print" id="steps-rest" hidden>'));
  assert.ok(readme.includes('- Testnet token: <!-- proof:token -->none recorded by the last run<!-- /proof:token -->. Every transaction:'));
  assertPagePasses(root);
  assert.deepEqual(syncFiles(root), []);

  // The placeholder files, and a file without a commit: still consistent text.
  put(root, { status: 'pending' }, { status: 'pending' });
  syncFiles(root);
  assert.ok(read(root, 'web/index.html').includes('<span id="proof-stamp">Not recorded yet.</span>'));
  assert.ok(!read(root, 'README.md').includes('built from commit'));
  assertPagePasses(root);

  // And a full run after it brings every row back.
  put(root, deploymentFile(), receiptsFile());
  syncFiles(root);
  assert.equal(read(root, 'web/index.html').split('data-result="PASS"').length - 1, 10);
  assertPagePasses(root);
});

test('a check with an unknown number is shown with the text of the file', () => {
  const rec = receiptsFile();
  rec.steps.push({ n: 11, title: 'An added check <b>', ok: true, expect: 'a & b', got: 'ok', txs: [] });
  const html = syncHtml(readFileSync(path.join(REPO, 'web', 'index.html'), 'utf8'), deploymentFile(), rec);
  assert.ok(html.includes('<tr><td>11. An added check &lt;b&gt; <span class="expect">Expected: a &amp; b</span></td><td class="res" data-result="PASS">PASS</td></tr>'));
});

test('a missing hook stops the script and changes no file', (t) => {
  const html = readFileSync(path.join(REPO, 'web', 'index.html'), 'utf8');
  const md = readFileSync(path.join(REPO, 'README.md'), 'utf8');
  for (const id of ['sum-token', 'sum-proof', 'proof-facts', 'proof-scope', 'proof-catch', 'rec-state', 'steps-key', 'steps-rest', 'steps-table', 'dep-state', 'split-proof-state', 'proof-stamp']) {
    assert.throws(() => syncHtml(html.replace(`id="${id}"`, 'id="gone"'), deploymentFile(), receiptsFile()), new RegExp(`index\\.html: .*id="${id}"`));
  }
  for (const name of ['token', 'commit', 'scope']) {
    assert.throws(() => syncReadme(md.replace(`<!-- /proof:${name} -->`, ''), deploymentFile(), receiptsFile()), new RegExp(`README\\.md: .*proof:${name} `));
  }

  const root = copyRepo(t);
  put(root, deploymentFile(), receiptsFile());
  const broken = read(root, 'README.md').replace('<!-- proof:commit -->', '');
  writeFileSync(path.join(root, 'README.md'), broken);
  const run = cli('--root', root);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /README\.md: expected one pair of markers <!-- proof:commit -->/);
  // index.html was in order, and it is not written either.
  assert.equal(read(root, 'web/index.html'), read(REPO, 'web/index.html'));
  assert.equal(read(root, 'README.md'), broken);
});

test('command line: --check reports and writes nothing', (t) => {
  const root = copyRepo(t);
  assert.equal(cli('--check', '--root', root).status, 0);
  put(root, deploymentFile(), receiptsFile());
  const out = cli('--check', '--root', root);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /out of sync .*web\/index\.html, README\.md/);
  assert.equal(read(root, 'web/index.html'), read(REPO, 'web/index.html'));
  const wrote = cli('--root', root);
  assert.equal(wrote.status, 0);
  assert.match(wrote.stdout, /updated: web\/index\.html, README\.md/);
  assert.equal(cli('--check', '--root', root).status, 0);
  // Unreadable data and unknown options are errors.
  writeFileSync(path.join(root, 'web', 'receipts.json'), '{ not json');
  const bad = cli('--root', root);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /web\/receipts\.json: not valid JSON/);
  assert.equal(cli('--chek').status, 1);
});

test('README: every linked transaction and the run totals are in the recorded run', () => {
  const readme = read(REPO, 'README.md');
  const receipts = JSON.parse(read(REPO, 'web/receipts.json'));
  const deployment = JSON.parse(read(REPO, 'web/deployment.json'));
  const known = new Set([deployment.tx]);
  for (const step of receipts.steps) for (const tx of step.txs || []) known.add(tx.hash);
  const linked = [...readme.matchAll(/nearblocks\.io\/txns\/([1-9A-HJ-NP-Za-km-z]+)/g)].map((m) => m[1]);
  assert.ok(linked.length >= 7);
  for (const hash of linked) assert.ok(known.has(hash), `README links a transaction the run did not record: ${hash}`);
  const whole = (units) => Math.round(Number(BigInt(units) / 10n ** 15n) / 1000).toLocaleString('en-US');
  const sp = receipts.split;
  assert.ok(readme.includes(`${sp.attempts} calls`));
  assert.ok(readme.includes(`${sp.fills} sales, ${sp.cap_hits} \`E_CAP\` rejections`));
  assert.ok(readme.includes(`${whole(sp.sold_total)} LOUD got out; the cap allowed at most ${whole(sp.bound)}`));
});

test('check 8 names the catch only for a run that recorded one', () => {
  const page = readFileSync(path.join(REPO, 'web', 'index.html'), 'utf8');
  const row = (title, expect) => `<tr><td>8. ${title} <span class="expect">Expected: ${expect}</span></td>`;
  const without = receiptsFile();
  assert.ok(syncHtml(page, deploymentFile(), without).includes(row(...CHECK_TEXT[8])));
  assert.ok(!syncHtml(page, deploymentFile(), without).includes('catches part of another exit'));
  const withCatch = receiptsFile();
  withCatch.steps.find((s) => s.n === 8).catch = { exit_id: '2', pass: true };
  const html = syncHtml(page, deploymentFile(), withCatch);
  assert.ok(html.includes(row(...CHECK_TEXT_CATCH)));
  assert.ok(!html.includes(row(...CHECK_TEXT[8])));
  // A catch that could not be run leaves `catch: null`: the row keeps the older text.
  const nullCatch = receiptsFile();
  nullCatch.steps.find((s) => s.n === 8).catch = null;
  assert.ok(syncHtml(page, deploymentFile(), nullCatch).includes(row(...CHECK_TEXT[8])));
});
