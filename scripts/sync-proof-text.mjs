// Writes the recorded testnet run into the static text of web/index.html and README.md.
//
//   node scripts/sync-proof-text.mjs            rewrite the two files from the data files
//   node scripts/sync-proof-text.mjs --check    change nothing; exit 1 if a file is out of sync
//   node scripts/sync-proof-text.mjs --root <dir>   work on another copy of the repository
//
// The page fills its proof section from web/deployment.json and web/receipts.json when its
// script runs. The same lines are also in the HTML itself, and the README names the token,
// the day and the commit. This script keeps those copies equal to the data files. Every
// string comes from the functions the page uses (web/ui-logic.js). No dependency.
//
// Hooks. In index.html, the elements with these ids: sum-token, sum-proof, proof-facts,
// proof-scope, rec-state, steps-key, steps-rest, steps-table, dep-state, split-proof-state,
// proof-stamp. In README.md, the text between <!-- proof:NAME --> and <!-- /proof:NAME -->
// for token, commit and scope. A missing hook stops the script with exit code 1.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as L from '../web/ui-logic.js';

const esc = L.escapeHtml;

// Short title and expectation of each check, as the static rows word them. A check with
// another number is shown with the title and expectation of the data file.
export const CHECK_TEXT = Object.freeze({
  1: ['Root account from the testnet faucet', 'funded'],
  2: ['Token deployed in one transaction, with no access key', 'empty key list; code hash matches the build'],
  3: ['Insider, 20 wallets and a late buyer created', '22 accounts'],
  4: ['Insider buys in the launch window', 'tokens are loud'],
  5: ['Insider splits across 20 wallets', 'every wallet holds loud tokens only'],
  6: ['One wallet tries a plain sell', 'refused, because loud tokens cannot be sold directly (E_NO_QUIET)'],
  7: ['Late buyer buys after the launch window, sells half', 'quiet tokens only; the sell goes through'],
  8: ['All 20 wallets shout; one tries to leave at once', '20 open exits; the early leave is refused (E_NOTICE)'],
  9: ['All 20 wallets call leave for one cap window', 'some sells go through; the rest are refused because the cap has no room left (E_CAP) or the exit ran out (E_EXPIRED)'],
  10: ['What left, against the cap', 'no more than the cap allows'],
});

export const SCOPE_SHORT = 'Recorded before two later rules, listed under Testnet proof. ';
export const NO_TOKEN_HTML = 'Not deployed yet.';
export const NO_TOKEN_README = 'none recorded by the last run';
export const NO_STAMP = 'Not recorded yet.';

const anchor = (href, label) => (href ? `<a href="${esc(href)}" rel="noopener">${esc(label)}</a>` : '');
const isoDay = (stamp) => (/^\d{4}-\d{2}-\d{2}T/.test(stamp) ? stamp.slice(0, 10) : '');

// The one element with this id: where its opening tag and its closing tag are.
function locate(html, id) {
  const found = [...html.matchAll(new RegExp(`<([a-z][a-z0-9]*)\\b[^<>]*\\sid="${id}"[^<>]*>`, 'g'))];
  if (found.length !== 1) {
    throw new Error(`web/index.html: expected one element with id="${id}", found ${found.length}`);
  }
  const [open, tag] = found[0];
  const openStart = found[0].index;
  const openEnd = openStart + open.length;
  const closeStart = html.indexOf(`</${tag}>`, openEnd);
  if (closeStart < 0) throw new Error(`web/index.html: the element with id="${id}" has no closing </${tag}>`);
  return { tag, open, openStart, openEnd, closeStart, closeEnd: closeStart + tag.length + 3 };
}

// Replaces the content of the element, and its opening tag when `open` is given.
function setElement(html, id, inner, open = null) {
  const at = locate(html, id);
  return html.slice(0, at.openStart) + (open ?? at.open) + inner + html.slice(at.closeStart);
}

function setOpenTag(html, id, open) {
  const at = locate(html, id);
  return html.slice(0, at.openStart) + open + html.slice(at.openEnd);
}

// Lines inside a list or table body, indented two spaces deeper than the line that opens it.
function lines(html, openStart, items) {
  const lineStart = html.lastIndexOf('\n', openStart) + 1;
  const indent = /^[ \t]*/.exec(html.slice(lineStart, openStart))[0];
  return `${items.map((x) => `\n${indent}  ${x}`).join('')}\n${indent}`;
}

function setRows(html, tableId, steps) {
  const table = locate(html, tableId);
  const openStart = html.indexOf('<tbody>', table.openEnd);
  const closeStart = html.indexOf('</tbody>', openStart);
  if (openStart < 0 || openStart > table.closeStart || closeStart < 0 || closeStart > table.closeStart) {
    throw new Error(`web/index.html: the table with id="${tableId}" has no <tbody>`);
  }
  const rows = steps.map((s) => {
    const [title, expect] = CHECK_TEXT[s.n] ?? [s.title || 'Untitled check', s.expect || 'not recorded'];
    return `<tr><td>${esc(s.n)}. ${esc(title)} <span class="expect">Expected: ${esc(expect)}</span></td><td class="res" data-result="${s.result}">${s.result}</td></tr>`;
  });
  return html.slice(0, openStart + '<tbody>'.length) + lines(html, openStart, rows) + html.slice(closeStart);
}

// index.html with the proof text of this pair of data files. Follows renderProof in web/app.js.
export function syncHtml(html, deployment, receipts) {
  const d = L.deploymentView(deployment);
  const r = L.receiptsView(receipts);
  const heads = L.proofHeadlines(d, r);
  let out = html;

  out = setElement(out, 'sum-token', d.token ? anchor(d.tokenHref, d.token) : NO_TOKEN_HTML);
  out = setElement(out, 'sum-proof', `${esc(heads[0].big)}. ${esc(heads[2].big)} ${r.scopeNote ? SCOPE_SHORT : ''}${anchor(heads[0].href, heads[0].linkText)}`);

  const facts = heads.map((x) => `<li data-state="${x.state}"><b>${esc(x.big)}</b><span>${esc(x.small)}</span>${anchor(x.href, x.linkText)}</li>`);
  out = setElement(out, 'proof-facts', lines(out, locate(out, 'proof-facts').openStart, facts));

  out = setElement(out, 'proof-scope', esc(r.scopeNote), `<p class="fine" id="proof-scope"${r.scopeNote ? '' : ' hidden'}>`);

  // Shown only when it adds something to the large line: a run that did not pass, a
  // transaction with no confirmed outcome, or no run at all.
  const quiet = r.state === 'ok' && r.unresolved === 0 && !r.error;
  out = setElement(out, 'rec-state',
    quiet ? '' : esc(r.error ? `${r.headline} The run stopped early: ${r.error}` : r.headline),
    quiet ? '<p class="state" id="rec-state" data-state="pending" hidden>' : `<p class="state" id="rec-state" data-state="${r.state}">`);

  const { key, rest } = L.splitChecks(r.steps);
  out = setRows(out, 'steps-key', key);
  out = setRows(out, 'steps-table', rest);
  out = setOpenTag(out, 'steps-rest', `<details class="fine-print" id="steps-rest"${rest.length ? '' : ' hidden'}>`);

  out = setElement(out, 'dep-state', esc(d.headline), `<p class="state" id="dep-state" data-state="${d.state}">`);

  const sp = r.split;
  const spState = sp.result === 'PASS' ? 'ok' : sp.result === 'FAIL' ? 'failed' : 'pending';
  out = setElement(out, 'split-proof-state', esc(sp.have ? `${sp.result}. ${sp.sentence}` : sp.sentence),
    `<p class="state" id="split-proof-state" data-state="${spState}">`);

  const stamp = r.generatedAt || d.generatedAt;
  out = setElement(out, 'proof-stamp', stamp ? `Recorded ${esc(stamp)}.` : NO_STAMP);
  return out;
}

function setMarked(md, name, content) {
  const open = `<!-- proof:${name} -->`;
  const close = `<!-- /proof:${name} -->`;
  const a = md.indexOf(open);
  const b = md.indexOf(close);
  if (a < 0 || b < a || md.indexOf(open, a + 1) >= 0 || md.indexOf(close, b + 1) >= 0) {
    throw new Error(`README.md: expected one pair of markers ${open} ... ${close}`);
  }
  return md.slice(0, a + open.length) + content + md.slice(b);
}

// README.md with the token, the day, the commit and the scope sentence of this pair.
export function syncReadme(md, deployment, receipts) {
  const d = L.deploymentView(deployment);
  const r = L.receiptsView(receipts);
  const dep = deployment && typeof deployment === 'object' ? deployment : {};
  let token = NO_TOKEN_README;
  if (d.token) {
    if (/[()\[\]]/.test(d.tokenHref)) throw new Error('web/deployment.json: the explorer link of the token holds a bracket and cannot be written as a Markdown link');
    const preset = typeof dep.preset === 'string' && /^[a-z0-9-]{1,24}$/.test(dep.preset) ? dep.preset : '';
    const day = isoDay(r.generatedAt || d.generatedAt);
    const passed = d.state === 'ok' && r.state === 'ok';
    token = `[${d.token}](${d.tokenHref})${d.zeroKeys ? ', no access keys' : ''}${preset ? `, ${preset} preset` : ''}${day ? `, recorded ${day}` : ''}${passed ? '' : ', the last run did not pass'}`;
  }
  const sha = dep.run && typeof dep.run.commit === 'string' && /^[0-9a-f]{7,40}$/.test(dep.run.commit) ? dep.run.commit.slice(0, 7) : '';
  let out = setMarked(md, 'token', token);
  out = setMarked(out, 'commit', sha ? ` and was built from commit \`${sha}\`, named in \`deployment.json\` as \`run.commit\`` : '');
  out = setMarked(out, 'scope', r.scopeNote
    ? ' Two rules came after that commit: a shout cannot be cancelled, and each account pays for its storage. Unit tests cover both until [the run](.github/workflows/proof.yml) is repeated.'
    : '');
  return out;
}

// Reads the four files under `root` and returns the paths that differ from what the data
// files say. Writes them unless `check` is set.
export function syncFiles(root, { check = false } = {}) {
  const file = (rel) => path.join(root, ...rel.split('/'));
  const json = (rel) => {
    let raw;
    try {
      raw = readFileSync(file(rel), 'utf8');
    } catch (e) {
      throw new Error(`${rel}: cannot be read (${e.code ?? e.message})`);
    }
    try {
      return JSON.parse(raw);
    } catch (e) {
      throw new Error(`${rel}: not valid JSON (${e.message})`);
    }
  };
  const deployment = json('web/deployment.json');
  const receipts = json('web/receipts.json');
  const targets = [['web/index.html', syncHtml], ['README.md', syncReadme]];
  // Both texts are computed before anything is written, so a missing hook changes no file.
  const results = targets.map(([rel, fn]) => {
    const before = readFileSync(file(rel), 'utf8');
    return { rel, before, after: fn(before, deployment, receipts) };
  });
  const changed = results.filter((x) => x.after !== x.before);
  if (!check) for (const x of changed) writeFileSync(file(x.rel), x.after);
  return changed.map((x) => x.rel);
}

function main(argv) {
  const args = argv.slice(2);
  const check = args.includes('--check');
  const at = args.indexOf('--root');
  const known = args.every((a, i) => a === '--check' || a === '--root' || (at >= 0 && i === at + 1));
  if (!known || (at >= 0 && !args[at + 1])) {
    console.error('usage: node scripts/sync-proof-text.mjs [--check] [--root <dir>]');
    return 1;
  }
  const root = at >= 0 ? path.resolve(args[at + 1]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let changed;
  try {
    changed = syncFiles(root, { check });
  } catch (e) {
    console.error(`sync-proof-text: ${e.message}`);
    return 1;
  }
  if (changed.length === 0) {
    console.log('proof text: web/index.html and README.md match the data files');
    return 0;
  }
  if (check) {
    console.error(`proof text out of sync with web/deployment.json and web/receipts.json: ${changed.join(', ')}. Run: node scripts/sync-proof-text.mjs`);
    return 1;
  }
  console.log(`proof text updated: ${changed.join(', ')}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv);
}
