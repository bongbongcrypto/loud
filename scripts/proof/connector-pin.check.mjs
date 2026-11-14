// The NEAR wallet connector the page loads on demand: the pinned URL still serves the
// file whose SHA-384 web/wallet-connect.js expects, and that file exports NearConnector
// and imports nothing. The file is downloaded and hashed here, never run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CONNECTOR } from '../../web/wallet-connect.js';

test('the pinned wallet connector URL serves the file with the pinned SHA-384', async () => {
  const res = await fetch(CONNECTOR.url);
  assert.equal(res.status, 200);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(createHash('sha384').update(bytes).digest('base64'), CONNECTOR.sha384);
  const src = bytes.toString('utf8');
  assert.match(src, /\bas NearConnector\b/);
  assert.doesNotMatch(src, /^\s*import\s/m);
  assert.ok(src.includes(`"${CONNECTOR.version}"`) || src.includes(`'${CONNECTOR.version}'`) || src.includes(CONNECTOR.version));
});
