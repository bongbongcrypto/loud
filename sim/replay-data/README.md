# Replay data

This folder holds the real data sets used by `sim/replay.mjs`. **It currently holds none.**

Each data set is one JSON file written by `node sim/replay.mjs --fetch ...`:

```
{
  "kind": "ohlcv_minute",
  "label": "name of the launch",
  "network": "solana",
  "pool": "pool address",
  "token": "token address",
  "total_supply": 1000000000,
  "documented": { "bundled_share_bps": 3000, "wallets": 40, "source_url": "public report" },
  "source": { "provider": "GeckoTerminal public API", "urls": ["every request URL"], "fetched_at": "ISO time" },
  "candles": [[unix_seconds, open, high, low, close, volume_usd], ...]
}
```

`candles` come from the API unchanged, sorted by time. `documented` is typed in by hand from a public report and must cite it.

## Why there is no data set yet (checked 2026-11-13)

The goal was to replay one real, publicly documented bundled memecoin dump from minute-level data that is free and needs no key.

| Source | Request | Answer |
|---|---|---|
| GeckoTerminal public API | minute OHLCV of the first candidate pool tried, HAWK / SOL `ExyGVXVRvUjJryo65vYUhLACcxhwYztKqa7jXqiT2tvr` (created 2024-12-04) with `before_timestamp=1733371200` | HTTP 401: the public API only serves the past 180 days |
| DexPaprika | 1-minute OHLCV of the same pool, no key | `plan_required`: intervals below 1 hour need an API key |
| DexPaprika | 1-hour OHLCV of the same pool, no key | `plan_required`: history beyond the last 24 hours needs an API key |
| DefiLlama `coins.llama.fi/chart` | 5-minute prices of the HAWK and LIBRA tokens around their launches | empty result |

Launches inside the 180-day window: public reports of bundled supply were found (press summaries of Bubblemaps posts from July to September 2026), but none of them both named a token address and documented the sales. Several unrelated tokens share each ticker, so matching a pool to a report would have been a guess. No data set was added on that basis.

The download path itself works: it was run against the live API for a recent pool and returned valid minute candles. That file was not kept, because the pool could not be tied to a public report.

## Adding a data set

1. Find a public report that names the token address and states the bundle share and wallet count.
2. Find the launch pool on GeckoTerminal (the launch must be within the last 180 days, or use a key with another provider and write the same JSON format).
3. Run `node sim/replay.mjs --fetch --network <network> --pool <pool> --hours 6 --label "<name>" --bundled-bps <bps> --wallets <n> --doc-url <report url>`.
4. Run `node sim/replay.mjs` to regenerate `sim/REPLAY.md`.
