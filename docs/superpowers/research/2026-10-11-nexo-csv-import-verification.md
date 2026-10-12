# Nexo CSV import - real-sample verification (2026-10-11)

Piece 2d, Task 6. The owner's two real Nexo exports were run through the real services. Counts and timings only: no amounts, ids, timestamps, balances, `Details` text or names are recorded here. Structural facts about the files are in `2026-10-11-nexo-csv-samples.md`.

## Method

- A throwaway jest spec (deleted afterwards, never committed) on a scratch MariaDB database `scratch_nexo_t6`, built from the real tenant migrations (`accounts` table stubbed with `is_syncing_owner`; audit and events faked).
- Real `CsvParserRegistry` (`PIONEX_CSV_PARSERS` + `NEXO_CSV_PARSERS`), real `CryptoConnectionRepository` / `CryptoCsvImportRepository`, real `PreviewCryptoCsvImportService`, `CommitCryptoCsvImportService`, `RollbackCryptoCsvImportService`.
- The Nexo connection was created through the real `CreateCsvOnlyConnectionService` (`mode = csv_only`, no adapter, no vault). A Pionex API connection was inserted for the cross-exchange refusal check.
- Scratch server: MariaDB 10.2.44, `max_allowed_packet` 16777216 (16 MB), `binlog_format` MIXED, `sql_mode` `IGNORE_SPACE,STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION`. The scratch database was dropped afterwards and the drop verified with `SHOW DATABASES`.
- Code under test: commit `56df87ee4` (HEAD of the branch at run time).

## Results (final run)

### Transactions export (`nexo:transactions`)

| Item | Count |
|---|---|
| Data rows | 13,042 |
| Recognised and importable | 13,042 |
| Rejects | 0 |
| Already imported (first upload) | 0 |
| Committed | 13,042 (0 skipped duplicate) |

Records by type (preview equals database): reward 11,035; adjustment 1,610; transfer 274; trade 44; deposit 42; credit 23; withdrawal 14 (sum 13,042; no `unparsed`).

Timings: preview 0.56-1.0 s, commit 1.5-1.7 s, rollback 0.24-0.26 s.

### Futures export (`nexo:futures`)

| Item | Count |
|---|---|
| Data rows (verified) | 4,671 |
| Recognised and importable | 4,671 |
| Rejects | 0 |
| Committed | 4,671 (0 skipped duplicate) |

Records by type (preview equals database): funding 3,845; trade 488; position 247; fee 48; transfer 43 (sum 4,671; no `unparsed`).

Timings: preview 0.18-0.35 s, commit 0.52-0.53 s, rollback 0.17 s.

**Row count note.** The sample note and the task brief said 4,670 data rows. The verified count is 4,671: the file has 4,671 newline characters and no trailing newline plus one header row, so `wc -l` and a naive reading are off by one. Both a CSV parse and the importer report 4,671.

### Other checks

- Total CSV raw rows with both files committed: 17,713 (13,042 + 4,671), all `source = 'csv'`.
- Second upload of the same bytes: refused `CSV_DUPLICATE_FILE` for both files.
- Cross-exchange refusal (registry matches by connection exchange): the Nexo transactions file and the Nexo futures file into the Pionex connection, and a Pionex `trading.csv` sample into the Nexo connection, were all refused `CSV_FORMAT_UNRECOGNIZED`; no raw rows were written (still 17,713).
- Rollback of both imports: status `rolled_back`, 0 raw rows left for the Nexo connection.

## Finding: float-noise decimals (and the ruling)

The first run (code at `5405a397f`, `isNexoDecimal` capped at 12 fractional digits) rejected 5 futures rows: 4 on column `Price` and 1 on column `Amount`. A masked-shape probe (digits replaced, no values) showed those cells carry 13 to 16 fractional digits, which is float noise from the exporter: `Price` on `MARKET_OPEN`/`MARKET_CLOSE` rows (4 cells) and `Amount` on a `FUNDING_FEE` row (1 cell). That first run imported 4,666 rows (funding 3,844; trade 484; position 247; fee 48; transfer 43). The rejects were the 4 trades and 1 funding row now imported in the final run.

Ruling (coordinator, commit `56df87ee4`): `isNexoDecimal` accepts up to 20 fractional digits. The value is stored as raw text in the payload and is never calculated on here, so wide noise is harmless; piece 3 must round or parse deliberately. If this is wrong: lower the cap and document the rejected rows.

## Mapping as implemented (provisional; raw records only, piece 3 re-interprets)

### Transactions export, column `Type` (exact match)

| Type | Record type |
|---|---|
| Interest, `Input Amount` > 0 | reward |
| Interest, `Input Amount` negative or zero | adjustment |
| Fixed Term Interest, Dividend, Exchange Cashback | reward |
| Earn Adjustment as a `Type` (not present in the samples) | adjustment |
| Exchange, Exchange Credit, Exchange Booster, Exchange Deposited On | trade |
| Deposit To Exchange, Top up Crypto | deposit |
| Withdrawal | withdrawal |
| Transfer In, Transfer Out, Transfer To Pro Wallet, Transfer From Pro Wallet, Locking Term Deposit, Unlocking Term Deposit, Transfer To Advanced, Transfer To Advanced Trading Bonus, Transfer From Advanced Trading Bonus, Advanced Trading Add Bonus Funds, Advanced Trading Reduce Bonus Funds | transfer |
| Loan Withdrawal, Manual Repayment, Manual Sell Order, Exchange Liquidation, Deposit Over Repayment | credit |
| Any other Type | unparsed (stored and counted, never dropped) |

Interest sign rule (ruling 6): `Interest` is not one economic event. A positive `Input Amount` is earned interest (`reward`); a negative or zero one (likely charges on credit lines, or zero rows) is `adjustment`. The raw `Credit Line` and amounts stay in the payload.

### Futures export, column `Type` (exact match)

| Type (Status) | Record type |
|---|---|
| MARKET_OPEN, MARKET_CLOSE with Status PLACED or LIQUIDATED | trade |
| MARKET_OPEN, MARKET_CLOSE with any other Status | unparsed |
| FUNDING_FEE | funding |
| REALIZED_PNL | position |
| LIQUIDATION_FEE | fee |
| TRANSFER_TO_WALLET | transfer |
| Any other Type | unparsed |

Row-level validation (rejects name the column only, never a value): timestamp (epoch ms in the supported range), non-empty `Id`, decimals (up to 20 fractional digits) in `Price`, `Amount`, `TradingFeeAmount`, `ExchangeRate`, `SourceAmount`, `Side` long/short (any case), `Position` open/close, and `Symbol` and `Amount` required for `ORDER` rows. Literal `null` and `-` and empty cells are treated as missing; the header `" Id"` is trimmed.

Record types `transfer` and `credit` were added to `CRYPTO_RECORD_TYPES` (varchar(16), no migration).

## Decisions before piece 3 / deployment

**I-1. Record-id dedupe is content-hash based (decide before piece 3).**
- Row ids are `csv:` plus a content hash that includes the record type, and that id sits in the unique key. Identical re-exports therefore dedupe.
- If piece 3 changes a provisional `recordType` in a parser, a newer full export would insert the old rows again under new ids: a double count.
- Any cell that Nexo renders differently in a later export of the same transaction (USD Equivalent, Details, float noise in amounts) also produces a new id, so the same transaction can be imported twice.
- Piece 3 must EITHER re-classify at normalisation time from `payload.Type` and never change the recordType assigned by the parser, OR add a Nexo natural-key dedupe on `Transaction` / `Id` that ignores the record type.
- Unverified: whether Nexo re-exports are byte-stable per row. The owner can export the same range twice and diff the files.

**I-2. App-wide validation pipe echoes the request body (fix before deployment or ZAP).**
- `packages/server/src/common/pipes/ClassValidation.pipe.ts` (lines 17-24, registered as `APP_PIPE` in `App.module.ts`) returns `target` / `value` in 400 responses. That includes the request body: `apiKey`, `apiSecret`, `passphrase` on a failed key-based connection create, and very likely auth passwords on other endpoints.
- Pre-existing, not introduced by this piece. Smallest fix: `validationError: { target: false, value: false }`.

**Decimal and USD parsing (piece 3 must handle).**
- `isNexoDecimal` leaves the integer part unbounded and allows up to 20 fractional digits. Piece 3 must bound and round deliberately before anything goes into a DECIMAL column.
- `isNexoUsd` rejects thousands separators. Unverified whether Nexo ever writes them; a file that does would be rejected.
- A 4-byte character (for example an emoji) in `Details` makes the whole file refused (2c behaviour). Editing rows to work around it changes their content hash, so the edited rows get new ids.

**`adjustment` is not one economic event.**
- The 1,610 `adjustment` rows lump together `Interest` rows with negative or zero `Input Amount` (likely interest charged on credit lines; see the Credit Line breakdown in the sample note) with any Pionex-style adjustments.
- Piece 3 must sub-classify `adjustment` by `Credit Line` and `Output Currency` (and the sign of the amounts) before posting.

**`Earn Adjustment` wording.**
- `Earn Adjustment` is not a `Type` value in the samples. However 4 `Interest` rows carry a Details family of `Earn Adjustment Flex Term`, and under the sign rule they import as `reward`. Piece 3 must not assume that family is absent or that it maps to `adjustment`; review those rows.

## Overlap note (ruling 5)

The transactions file's `Transfer To Advanced` (43 rows) and the futures file's `TRANSFER_TO_WALLET` (43 rows) describe the same Savings-to-Futures transfers (matched 43/43 in the sample analysis). Both import as `transfer` records and are NOT de-duplicated. Piece 3 must treat each pair as one internal transfer.

## Limitations

- Imported records do not feed balances or the ledger. A csv_only connection shows no balances (balances come from snapshots only) until piece 3.
- The mapping is provisional until piece 3. Not confirmed: the semantics of `Advanced Trading ... Bonus Funds` (mapped `transfer`; could be promotional income), loan / credit-line legs (`credit`: which leg is the economic amount), and `Earn Adjustment`: no row has it as a `Type` (the mapping is untested), but 4 `Interest` rows carry the Details family `Earn Adjustment Flex Term` and import as `reward` under the sign rule. `adjustment` (1,610 rows) also mixes negative or zero `Interest` with other adjustments: see Decisions below.
- `Details` may contain a person's name (seen in a loan withdrawal family). It is kept in the stored raw payload only.
- Futures order-state values beyond `PLACED` and `LIQUIDATED` are unknown and stored as `unparsed`; the position / deal structure (opens and closes do not share a `DealId`) is not reconstructed.
- Production database settings (`max_allowed_packet`, `binlog_format`, `sql_mode`) are still unverified; only the scratch server values above are known.
- Real rows stored as `varchar` raw text with up to 20 fractional digits; nothing here parses them numerically.

## Security notes

- File content is untrusted: bounded reader (10 MB, 200,000 rows, 2,000 characters per cell), exact header signature, per-row validation, parsers never throw, cells stored verbatim and never evaluated.
- No file is stored (commit re-sends the file, sha256 compared). Reject reasons, previews, errors and audit metadata carry column names and counts only; `Details` is never logged.
- A csv_only connection stores `''` in both credential columns (ruling 1), has no vault entry, no adapter, no sync queue and no `created` event; every API-only action returns 409 `CRYPTO_CONNECTION_CSV_ONLY`.
- The real files stayed outside git; no real value appears in code, docs, logs, commit messages or reports.

## NOT done

- OWASP ZAP scan (no staging target).
- Alibaba open-code-review (needs an external LLM key).
- Authenticated live end-to-end upload through the running app with a real session, and a browser pass of the Nexo dialog.
- The Cloudflare security-audit skill was not run on this piece.

## Owner live-check steps (Nexo)

1. Restart the API so it runs the current build (`~/.restart-api.sh`); no migration is needed.
2. Crypto page: Add CSV-only connection, pick Nexo, label it, optionally map an asset account. The row should show no balances, no Sync now / Pause / Rotate key.
3. Import CSV on the Nexo row: upload the transactions export first, check the preview (13,042-style counts, 0 rejects), commit; then the futures export. Expect `Transfer` rows in both (the overlap above).
4. Open the import history and check filenames and timestamps; re-upload one file and confirm the duplicate refusal.
5. Roll back one import and confirm its rows disappear, then re-import it.
6. Try a Pionex file on the Nexo row and a Nexo file on a Pionex row: both must be refused as unrecognised.

## Open follow-ups

- **Owner decision pending:** the app-wide `ClassValidation.pipe` echoes the request body in 400 responses, including `apiKey` / `apiSecret` on a failed key-based `POST /crypto/connections`. Fix: `validationError: { target: false, value: false }`. It affects every endpoint, so it was not changed in this piece.
- Deferred minors from the SDD review ledger: `parseNexoUtc` duplicates Pionex `parseUtc` (~15 lines); no exact-boundary tests for `parseEpochMs`; `isNexoUsd` has no fractional cap; no test for `MARKET_*` with a null Status; `Input`/`Output Amount` not passed through `nexoCell`; csv-only label max 255 vs rename 100; blank label reuses `CRYPTO_CREDENTIALS_REQUIRED`; `isCsvOnly` lives in `commands/assertApiMode.ts` but is imported by queries and sync; no mode skip in the sync worker; Crypto widget empty state still says "Sync now" for csv-only-only orgs; the connections head note still has API-key wording; dead `.head > .bp4-button` SCSS; csv_only rows show a status tag.
