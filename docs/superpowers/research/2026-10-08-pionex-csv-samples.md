# Pionex CSV report samples: shapes, mapping and real-sample verification

Date: 2026-10-11 (samples exported 2026-10-07, window 2026-01-01 to 2026-10-07). Source: the owner's Pionex transaction export folder (`~/Screenshots/pionex_txn_2026-01-01_2026-10-07_gen_2026-10-07/`, 11 CSV reports).

This note records report shapes (column names), row counts and how the importer maps them. It deliberately contains NO real values from the files (no amounts, prices, order or transaction ids, timestamps, balances or symbols).

## Report shapes

Headers are matched exactly and in order (signature match, `csv/parsers/pionex/pionex.parsers.ts`). Cell text is never interpreted as a formula.

| Report file | Header columns | Parser id | Record type | Action |
|---|---|---|---|---|
| raw-trading-details.csv | date(UTC+0), executed_qty, amount, price, order_type, side, symbol, state, fee, fee_coin, market_type, tax_id | pionex:raw-trading-details | `trade` (FILLED with executed_qty > 0), else `unparsed` | import |
| trading.csv | date(UTC+0), executed_qty, amount, price, side, symbol, fee, fee_coin, market_type, tax_id | pionex:trading | `trade_summary` | import |
| staking.csv | date(UTC+0), Received Quantity, Received Currency, Sent Quantity, Sent Currency, tag | pionex:staking | `reward` (received row), `unparsed` (row with a sent quantity) | import |
| others.csv | date(UTC+0), coin, amount, tag, comment | pionex:others | `funding` (tag FundingFee, signed), other tags `adjustment` | import |
| position_futures.csv | position_id, symbol, position_side, open_time, close_time, pnl, fee, funding_fee | pionex:position-futures | `position` (occurred at close_time) | import |
| convert.csv | date(UTC+0), sell_coin, sell_amount, buy_coin, buy_amount | pionex:convert | any data row `unparsed` | import (header-only in sample) |
| deposit-withdraw.csv | date(UTC+0), tx_type, amount, coin, network, txid, fee | pionex:deposit-withdraw | any data row `unparsed` | import (header-only in sample) |
| dust-collector.csv | date(UTC+0), amount, coin, price, swap_value | pionex:dust-collector | any data row `unparsed` | import (header-only in sample) |
| structured-products.csv | date(UTC+0), Received Quantity, Received Currency, Sent Quantity, Sent Currency | pionex:structured-products | any data row `unparsed` | import (header-only in sample) |
| for-cointracker.csv | Date, Received Quantity, Received Currency, Sent Quantity, Sent Currency, Fee Amount, Fee Currency, Tag | pionex:for-cointracker | none | refused, `CSV_DERIVED_EXPORT_REFUSED` |
| for-cointracking.csv | Type, Buy Amount, Buy Currency, Sell Amount, Sell Currency, Fee, Fee Currency, Exchange, Trade-Group, Comment, Date, Tx-ID | pionex:for-cointracking | none | refused, `CSV_DERIVED_EXPORT_REFUSED` |

The two `for-*` files are Pionex's re-formatted exports for third-party tax tools (derived from the primary reports), so importing them as well would double count.

## Ruling 1: fill overlap (raw-trading-details canonical)

`raw-trading-details.csv` has one row per fill and carries `order_type` and `state`; it is canonical and becomes `trade` records. `trading.csv` is the same fills grouped by `tax_id`; it is stored as `trade_summary` (not for ledger posting) so nothing is double counted. Non-FILLED states or zero executed quantity are stored as `unparsed` and counted, never as `trade`. A later piece (3) must not post `trade_summary` to the ledger. Owner may override the ruling.

## Real-sample verification (2026-10-11)

Method: a throwaway jest spec (not committed, deleted afterwards) ran every file through the real preview and commit services with the real parser registry and the real repository, on a scratch MariaDB database built from the real crypto tenant migrations (including `20261008000000_create_crypto_csv_imports`; the `accounts` table was a minimal stub with an `id` column because the crypto migration only needs it as a foreign-key target). Production-style `INSERT IGNORE` batches, `SHOW WARNINGS` fail-closed check, connection lock and rollback all ran for real; the audit service and event emitter were fakes. The scratch database was dropped by the spec.

Per file (preview, then commit, then a second upload of the same bytes):

| File | Data rows | Records by type | Rejects | Committed | Second upload |
|---|---|---|---|---|---|
| trading.csv | 205 | trade_summary 205 | 0 | 205 imported, 0 skipped | refused `CSV_DUPLICATE_FILE` (at preview) |
| raw-trading-details.csv | 319 | trade 318, unparsed 1 | 0 | 319 imported, 0 skipped | refused `CSV_DUPLICATE_FILE` |
| staking.csv | 6,699 | reward 6,699 | 0 | 6,699 imported, 0 skipped | refused `CSV_DUPLICATE_FILE` |
| others.csv | 2,088 | funding 2,087, adjustment 1 | 0 | 2,088 imported, 0 skipped | refused `CSV_DUPLICATE_FILE` |
| position_futures.csv | 2 | position 2 | 0 | 2 imported, 0 skipped | refused `CSV_DUPLICATE_FILE` |
| convert.csv | 0 (header only) | none | 0 | committed, 0 rows | refused `CSV_DUPLICATE_FILE` |
| deposit-withdraw.csv | 0 (header only) | none | 0 | committed, 0 rows | refused `CSV_DUPLICATE_FILE` |
| dust-collector.csv | 0 (header only) | none | 0 | committed, 0 rows | refused `CSV_DUPLICATE_FILE` |
| structured-products.csv | 0 (header only) | none | 0 | committed, 0 rows | refused `CSV_DUPLICATE_FILE` |
| for-cointracker.csv | n/a | n/a | n/a | refused at preview `CSV_DERIVED_EXPORT_REFUSED`, nothing written | n/a |
| for-cointracking.csv | n/a | n/a | n/a | refused at preview `CSV_DERIVED_EXPORT_REFUSED`, nothing written | n/a |

Totals: 9,313 CSV raw records committed across 9 imports (205 + 319 + 6,699 + 2,088 + 2 = 9,313); the pre-existing synthetic API-sourced row, the balance snapshot, sync-run and connection tables were unchanged by every commit (per-commit table deltas were zero outside CSV rows). Rolling back all 9 imports (newest first) left 0 CSV rows, the API row intact, all 9 imports `rolled_back`.

Timings (this WSL host, one process, scratch DB on the local MariaDB):

| File | Preview | Commit | Rollback |
|---|---|---|---|
| staking.csv (6,699 rows) | 236 ms | 696 ms | 270 ms |
| others.csv (2,088 rows) | 220 ms | 611 ms | 91 ms |
| raw-trading-details.csv (319) | 36 ms | 82 ms | 78 ms |
| trading.csv (205) | 44 ms | 134 ms | 114 ms |
| other files | 13 to 182 ms | 23 to 42 ms | 29 to 51 ms |

The largest commit (6,699 rows, 14 insert batches of at most 500 rows) finished in under 1 second, inside one transaction.

Scratch server settings (for the limits question): MariaDB 10.2.44, `max_allowed_packet` 16,777,216 (16 MB; batches are capped at 500 rows and 4 MB of payload so a batch cannot exceed it), `binlog_format` MIXED, `sql_mode` IGNORE_SPACE, STRICT_TRANS_TABLES, ERROR_FOR_DIVISION_BY_ZERO, NO_AUTO_CREATE_USER, NO_ENGINE_SUBSTITUTION (strict transactional mode on), `innodb_lock_wait_timeout` 50 s, server charset latin1 (the scratch database and the app connection use utf8). The production database settings are unverified.

## Observations and limits of this verification

- Header-only reports (convert, deposit-withdraw, dust-collector, structured-products) are recognised and import with zero rows, but because the sample files contain no data rows the row semantics of those reports are unproven. Any real data row currently becomes `unparsed` (stored verbatim, never posted) after the date column validates.
- A header-only file counts as a normal import: committing it creates an import record, so a second upload is refused as a duplicate.
- No authenticated browser or HTTP upload was exercised here; this verification covers the services and the database only.
- The sample covers one account; other account shapes are untested.
