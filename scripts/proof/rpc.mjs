// Minimal NEAR JSON-RPC client with failover. Dependency-free (global fetch, Node 20+).
// Method names and shapes follow https://docs.near.org/api/rpc/introduction.

export class RpcError extends Error {
  constructor(error) {
    const text = JSON.stringify(error).slice(0, 600);
    super(text);
    this.name = 'RpcError';
    this.rpcName = error?.name ?? null; // HANDLER_ERROR, REQUEST_VALIDATION_ERROR, INTERNAL_ERROR
    this.cause_ = error?.cause?.name ?? null; // UNKNOWN_ACCOUNT, TIMEOUT_ERROR, INVALID_TRANSACTION, ...
    this.text = text;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createRpc({ urls, log = () => {}, timeoutMs = 45_000 }) {
  if (!urls?.length) throw new Error('no RPC urls');
  let current = 0;
  let id = 0;
  const blockTs = new Map();

  // One JSON-RPC call. Transport problems (network, 429, 5xx without a JSON-RPC body)
  // rotate to the next URL with backoff. JSON-RPC errors are thrown as RpcError at once.
  async function call(method, params, { tries = 8 } = {}) {
    let last = null;
    for (let attempt = 0; attempt < tries; attempt++) {
      const url = urls[current % urls.length];
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status === 429) throw new Error('HTTP 429 (rate limited)');
        let body = null;
        try {
          body = await res.json();
        } catch {
          throw new Error(`HTTP ${res.status} with a non-JSON body`);
        }
        if (body && body.error) {
          const err = new RpcError(body.error);
          // A node-side fault or a provider's own error body (throttling) is a transport
          // problem: try the next endpoint. Named NEAR errors go to the caller.
          if (err.rpcName === 'INTERNAL_ERROR' || (!err.rpcName && !err.cause_)) throw new Error(`endpoint error ${err.text.slice(0, 160)}`);
          throw err;
        }
        if (!res.ok || !body || body.result === undefined) throw new Error(`HTTP ${res.status} without a result`);
        return body.result;
      } catch (e) {
        if (e instanceof RpcError) throw e;
        last = e;
        current += 1;
        log(`rpc: ${method} via ${new URL(url).host} failed (${e.message}); next: ${new URL(urls[current % urls.length]).host}`);
        await sleep(Math.min(500 * 2 ** attempt, 8000));
      }
    }
    throw new Error(`rpc: ${method} failed on every endpoint: ${last?.message}`);
  }

  const query = (params) => call('query', { finality: 'final', ...params });

  async function viewAccount(accountId) {
    return query({ request_type: 'view_account', account_id: accountId });
  }

  async function accountExists(accountId) {
    try {
      await viewAccount(accountId);
      return true;
    } catch (e) {
      if (e instanceof RpcError && e.cause_ === 'UNKNOWN_ACCOUNT') return false;
      throw e;
    }
  }

  // -> { nonce, block_hash, block_height, permission } or null when the key is not on the account
  async function accessKey(accountId, publicKey) {
    try {
      const r = await query({ request_type: 'view_access_key', account_id: accountId, public_key: publicKey });
      if (r.error) return null; // older nodes report a missing key inside the result
      return r;
    } catch (e) {
      if (e instanceof RpcError && (e.cause_ === 'UNKNOWN_ACCESS_KEY' || e.cause_ === 'UNKNOWN_ACCOUNT')) return null;
      throw e;
    }
  }

  async function accessKeyList(accountId) {
    const r = await query({ request_type: 'view_access_key_list', account_id: accountId });
    return r.keys;
  }

  // Call a view method and parse its JSON result.
  async function viewFunction(accountId, methodName, args = {}) {
    const r = await query({
      request_type: 'call_function',
      account_id: accountId,
      method_name: methodName,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
    });
    if (r.error) throw new Error(`view ${methodName}: ${String(r.error).slice(0, 300)}`);
    return JSON.parse(Buffer.from(r.result).toString('utf8'));
  }

  async function finalBlock() {
    const r = await call('block', { finality: 'final' });
    return { hash: r.header.hash, height: r.header.height, timestamp: BigInt(r.header.timestamp_nanosec) };
  }

  // Block timestamp in nanoseconds (BigInt), cached by hash.
  async function blockTimestamp(blockHash) {
    if (blockTs.has(blockHash)) return blockTs.get(blockHash);
    const r = await call('block', { block_id: blockHash });
    const ts = BigInt(r.header.timestamp_nanosec);
    blockTs.set(blockHash, ts);
    return ts;
  }

  // Submit a signed transaction and wait for finality. A node-side timeout is not an
  // error: the transaction is then polled by hash until it is final.
  async function sendAndWait({ signedTxBase64, hash, senderId, maxWaitMs = 120_000 }) {
    try {
      return await call('send_tx', { signed_tx_base64: signedTxBase64, wait_until: 'FINAL' });
    } catch (e) {
      const timeout = e instanceof RpcError ? e.cause_ === 'TIMEOUT_ERROR' : true;
      if (!timeout) throw e;
      log(`rpc: send_tx ${hash} did not confirm in one call; polling`);
    }
    const until = Date.now() + maxWaitMs;
    let last = null;
    while (Date.now() < until) {
      try {
        return await call('tx', { tx_hash: hash, sender_account_id: senderId, wait_until: 'FINAL' });
      } catch (e) {
        const pending = e.cause_ === 'TIMEOUT_ERROR' || e.cause_ === 'UNKNOWN_TRANSACTION';
        if (e instanceof RpcError && !pending) throw e;
        last = e;
        await sleep(2000);
      }
    }
    throw new Error(`transaction ${hash} was not final after ${maxWaitMs / 1000}s: ${last?.message ?? ''}`);
  }

  return {
    call, viewAccount, accountExists, accessKey, accessKeyList, viewFunction,
    finalBlock, blockTimestamp, sendAndWait,
    currentUrl: () => urls[current % urls.length],
  };
}
