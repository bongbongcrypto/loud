# Replay data

This folder holds the real data sets used by `sim/replay.mjs`. `node sim/replay.mjs` reads every `.json` file here and writes `sim/REPLAY.md`.

| File | Launch | Source | What the file holds |
|---|---|---|---|
| `case-1.json` | pump.fun mint `7oE8o8kS6iyn5GyGhaBoi2HNz9M9m6n7VEdUWaxpump`, 2026-06-15 | [Bitquery report](https://bitquery.io/investigations/pump-fun-snipers-bundles) | The 1,001 sales of the four wallets named in the Bitquery report as bundled wallets. They bought 79.13% of supply in the creation block and sold all of it within 1,060 s. |
| `case-2.json` | RKC, pump.fun mint `7HgfXftRBBqsYtAEYcqjGLQrNJLL6Tww9ek4rE3Apump`, 2026-05-11 | [Lookonchain post](https://x.com/lookonchain/status/2054007728872603911) | The 1,143 sales of the ten wallets Lookonchain attributes to the developer. They bought 39.52% of supply in the first 184 s and sold all of it within 1,791 s. |

What each source states, and what it leaves out, is written in the file under `sources`. Three points matter when reading the numbers:

- The Bitquery report says 79% and 18 minutes. The 18 minutes covers five wallets. The file measures the four bundled wallets: 79.13% and 1,060 s. The fifth wallet and the dev wallet are listed under `other_wallets_in_report` and are left out of the schedule.
- The Lookonchain post gives the ten wallets and the 39.52%, but no mint address and no timing. The mint is derived: it is the only pump.fun mint all ten wallets bought that day, and they bought the 395.18M tokens the post states. The timing is measured here.
- The ten RKC wallets bought over about three minutes. They were not in one block.

## Where the sales come from

Solana public RPC, `api.mainnet-beta.solana.com`, no key: `getSignaturesForAddress` on each wallet's token account, then `getTransaction` for every signature. A sale is a transaction in which the wallet's token balance fell and its SOL balance rose. The token amount is the exact balance change. No token left these wallets by plain transfer to an outside address.

## Format: `sell_schedule`

```
{
  "kind": "sell_schedule",
  "label": "name of the launch",
  "chain": "solana",
  "token": { "address": "mint", "launchpad": "pump.fun", "total_supply": 1000000000, "decimals": 6 },
  "launch_ts": 1781531897,
  "launch_iso": "2026-06-15T13:58:17Z",
  "sources": [{ "url": "public report", "publisher": "who and when", "what_it_states": "..." }],
  "bundle": {
    "described_as": "how the source describes the wallets",
    "share_bps_reported": 7900, "wallets_reported": 4,
    "wallets": ["as listed by the source"],
    "share_bps_measured": 7913.37,
    "buy_timing": "...", "last_buy_s": 0, "first_sell_s": 138, "last_sell_s": 1060
  },
  "aggregated_by_minute": [{ "minute": 2, "share_of_supply_bps": 282.3464 }, ...],
  "cumulative": { "1m": { "tokens": 0, "supply_bps": 0, "pct_of_bundle": 0 }, "5m": ..., "24h": ... },
  "per_wallet": { "<wallet>": { "bought": 0, "sold": 0, "first_sell_s": 0, "last_sell_s": 0, "sells": 0, "first_sell_tx": "...", "last_sell_tx": "..." } },
  "data_source": "...",
  "caveats": ["..."],
  "sells": [[seconds_since_launch, index_into_bundle_wallets, tokens_sold], ...]
}
```

The replay reads `aggregated_by_minute`, the wallet count and `bundle.last_buy_s`. Minute `m` holds the sales from `m * 60` to `m * 60 + 59` seconds after launch. `sells` is every sale, kept so that the schedule can be recomputed; the tests do that. Transaction signatures are kept only for each wallet's first and last sale, to keep the files small.

## Format: `ohlcv_minute`

The older input kind, minute candles of a pool, still works. No file of this kind is in the folder: candles do not say who traded, and the two schedules above do.

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

`node sim/replay.mjs --fetch --network <network> --pool <pool> --hours 6 --label "<name>" --bundled-bps <bps> --wallets <n> --doc-url <report url>` writes such a file from the GeckoTerminal public API. `--from <ISO time>` starts later than the pool creation. The public API only serves the last 180 days.

## Adding a data set

1. Find a public report that names the wallets, and the token or enough to derive it.
2. Collect every sale of those wallets from a public RPC and write a `sell_schedule` file.
3. Run `node sim/replay.mjs` to write `sim/REPLAY.md` again, then `node --test sim/replay.test.mjs`.

`--data <folder>` reads data files from another folder and `--out <folder>` writes `REPLAY.md` into another folder.
