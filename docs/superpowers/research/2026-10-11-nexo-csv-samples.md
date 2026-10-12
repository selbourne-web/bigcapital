# Nexo CSV samples - structural findings (2026-10-11)

Source: owner's two real Nexo exports. No real values recorded here (no amounts, ids, timestamps, balances, detail text). Counts and enum-like values only.
Analysis was read-only (node scripts run from the home dir, deleted afterwards).

## File 1: transactions export (`nexo_transactions_10-06-2026_22-19-19.csv`)

Format facts
- 13,042 data rows, 12 columns, no BOM, header has NO leading space, LF line endings, trailing newline, no wrong-width rows.
- ONLY the Details column is double-quoted (one quoted field per row; other cells unquoted). Use a real CSV parser, but do not require quoting on other columns.
- Header: `Transaction, Type, Credit Line, Input Currency, Input Amount, Output Currency, Output Amount, USD Equivalent, Fee, Fee Currency, Details, Date / Time (UTC)`.
- `Transaction`: unique in all 13,042 rows, shape `NXT` + 22 alphanumeric chars (25 total). No duplicate ids.
- `Date / Time (UTC)`: always `YYYY-MM-DD HH:MM:SS` (UTC, no timezone suffix, no fractional secs). File order is DESCENDING by time (newest first). Range: 2019-03 to 2026-10.
- Amount columns (`Input Amount`, `Output Amount`): plain decimals only (no thousands separators, no scientific notation, no currency symbols, none empty). Max 8 decimal places for transactions amounts. Input is negative in 1,817 rows, positive in 11,219, zero in 6. Output is never negative (0 in 1,575 rows, positive otherwise).
- `USD Equivalent`: NEVER a plain decimal - always a `$`-prefixed value (shapes seen: `$d.dd`, `$dd.dd`, `$ddd.dd`, i.e. every observed value looks like it is below $1,000; a thousands separator / larger magnitude has not been seen in this sample but should be tolerated). No negatives.
- `Fee`: literal `-` in 13,025 rows; a plain decimal (positive, max 8 dp) in 17 rows. `Fee Currency`: literal `-` when no fee; else one of USDX/USDT/USD/USDC.
- `Output Currency` is the literal `-` in 1,120 rows (rows that have no output leg). `Input Currency` is never `-`.
- `Credit Line`: empty string in 12,937 rows, `Classic` in 105 rows.
- `Details` is never empty. Almost always `approved / <text>` or `completed` (see families). One family contains a person's name (3 rows of Loan Withdrawal) - treat Details as potentially containing PII; do not log it.
- No leading/trailing whitespace inside any cell.
- Ticker oddities: a currency literally named `A` (1,698 Input rows; appears under Interest and Top up Crypto), and `xUSD` and `USDX` (distinct tickers; xUSD only appears with Credit Line `Classic`-style/interest rows). Fiat `USD` also appears as a currency. Tickers are not normalised (no `BTC`-style mapping needed beyond verbatim).
- Input currency distinct values: xUSD, USDT, USDX, NEXO, XLM, TRX, SOL, DOT, USDC, SWEAT, USD, A, LINK, RENDER, AVAX, XRP, PAXG, GMT, FLR, APT. Output adds: ONDO, WLD (and `-`). (Also EOS appears inside Details text of Interest rows as "<TICKER> Interest Earned" but is not an Input/Output Currency in the list above - the detail ticker does not always equal the row currency; it mismatched in 1,695 Interest rows. Do not trust the Details ticker.)
- Duplicates: ids unique; ignoring the id column exactly 1 pair of rows is identical (both Interest, zero-value rows). Do NOT dedupe on content; dedupe on `Transaction`.

Sign conventions
- Input Amount is the debit/credit leg: negative = left the Savings (or source) wallet; positive = arrived. Output Amount is always >= 0 and appears as the "other leg" / resulting amount. For many same-currency types `abs(Input) == Output` (e.g. all 29 Locking Term Deposit, all 12 Transfer In).
- Input and Output currencies are the same in 11,867 rows.

### Types (27 distinct), counts, populated columns, meaning
Legend: In/Out sign = +/-/0/n-a (`-` literal). Fee = whether Fee column holds a number. CL = Credit Line.

| Type | Rows | CL | Input | Output | Fee | Meaning (guess) |
|---|---|---|---|---|---|---|
| Interest | 12,585 | Classic on 105 (all xUSD), else empty | mixed (+10,975 / -1,608 / 0 x2) | + (11,139) or 0 (1,446) | none | Mixed. See interest breakdown below. |
| Exchange | 35 | empty | - | + | 4 rows | Currency conversion (details "Exchange X to Y"); input leg negative, output positive, different currencies. Certain. |
| Exchange Credit | 2 | empty | - | + | none | Conversion (USDX to USDC). Likely same as Exchange via credit. Fairly certain. |
| Exchange Booster | 2 | empty | - | + | none | Conversion booster variant (stable to SOL). Fairly certain. |
| Exchange Deposited On | 5 | empty | - | + | none | Fiat USD converted to USDX on top-up (details "USD to USDX"). Fairly certain. |
| Deposit To Exchange | 5 | empty | + | + | yes (all 5) | Fiat top-up (details "USD Top Up"): input USD, output USDX, fee in USD. Deposit. Uncertain which leg is the economic amount; both populated. |
| Top up Crypto | 37 | empty | + | + | none | Crypto deposit received (details are a tx hash, `Credit Granting Top Up`, or similar). Fairly certain. |
| Withdrawal | 14 | empty | - | + | 7 rows | Crypto withdrawal off platform (details "<TICKER> withdrawal"). Output is positive though input negative - output likely the net/sent amount. Certain on meaning, not on which amount is net. |
| Loan Withdrawal | 6 | empty | - | + | 1 row | Credit-line draw: borrow USDX/USDT/USDC against collateral (input USD/USDX negative; output stable positive). Uncertain on leg semantics. Details include one with a person name. |
| Manual Repayment | 7 | empty | + | 0 | none | Loan repayment from wallet balance ("Crypto Repayment"). Uncertain sign meaning (input positive). |
| Manual Sell Order | 7 | empty | - | + (5) / 0 (2) | none | Collateral sold to repay loan (details "Crypto Repayment"). Fairly certain. |
| Exchange Liquidation | 2 | empty | + | + | none | Collateral liquidated/converted to repay (details "Crypto repayment / Exchange USDT to USDX"). Liquidation. Fairly certain. |
| Deposit Over Repayment | 1 | empty | + | 0 | none | Refund of over-repayment ("Return of over-repayment"). Certain. |
| Transfer Out | 30 | empty | - (26) / 0 (4) | + | none | Internal: Savings wallet to Credit Line wallet (incl. auto-transfer, one Booster). Not external. |
| Transfer In | 12 | empty | + | + | none | Internal: Credit Line wallet back to Savings wallet. Not external. |
| Locking Term Deposit | 29 | empty | - | + | none | Internal: Savings to Term wallet (NEXO/XRP). |
| Unlocking Term Deposit | 29 | empty | + | + | none | Internal: Term wallet back to Savings. |
| Fixed Term Interest | 29 | empty | + | + | none | Interest earned on term deposit (28 rows "Term Deposit Interest", 1 "in kind" paid in NEXO). Income. |
| Transfer To Pro Wallet / Transfer From Pro Wallet | 9 / 4 | empty | - / + | + | none | Internal: Savings <-> Nexo Pro wallet. |
| Transfer To Advanced | 43 | empty | - | + (42) / 0 (1) | none | Internal: USDT Savings -> Futures wallet ("Transfer from Savings Wallet to Futures Wallet"). CROSS-FILE: matches the futures file's TRANSFER_TO_WALLET rows 1:1 (see below). |
| Transfer To Advanced Trading Bonus | 29 | empty | - | 0 | none | Bonus-funds move into advanced trading (USDT). Internal. Uncertain. |
| Transfer From Advanced Trading Bonus | 85 | empty | + | 0 | none | Reverse of above (bonus funds back). Internal. Uncertain. |
| Advanced Trading Add Bonus Funds | 2 | empty | + | 0 | none | Bonus funds credited to advanced trading (USDT). Promotional income or internal. Uncertain. |
| Advanced Trading Reduce Bonus Funds | 2 | empty | - | 0 | none | Bonus funds clawed back. Uncertain. |
| Exchange Cashback | 26 | empty | + | + | none | Cashback bonus on Exchange trades (details "<n>% on top of your Exchange transaction"). Reward. Certain. |
| Dividend | 5 | empty | + | + | none | NEXO loyalty/base dividend ("Loyalty Dividend", "Base Dividend"). Reward/income. Certain. |

Notes on empty Output: for rows whose Output Currency is `-`, Output Amount is `0`, not empty. Types that use the `-` currency: Interest (a subset), Advanced Trading Add/Reduce Bonus Funds, Transfer To/From Advanced Trading Bonus, Transfer To Advanced (mostly not; see above), Deposit Over Repayment.

#### Interest breakdown (12,585 rows) - the dominant type
Details families (numbers replaced): `approved / <TICKER> Interest Earned` (10,971 rows), `approved / Interest` (1,610), `approved / Earn Adjustment Flex Term` (4).
| Shape | Rows | Reading |
|---|---|---|
| Input +, Output +, same currency, `<TICKER> Interest Earned` | 10,483 | Interest earned on savings (abs(Input) == Output). Income. |
| Input +, Output 0, same currency, `<TICKER> Interest Earned` | 488 | Interest earned recorded with zero output. Uncertain (maybe in-kind / NEXO-boost split). |
| Input -, Output 0, Output Currency `-`, `Interest` | 956 | Negative interest line with no output leg. Likely interest CHARGED/paid on a credit line or a reversal. Uncertain. |
| Input -, Output +, same currency, `Interest` | 547 (non-CL) + 105 (CL Classic, xUSD) | Interest paid on borrowed amount (Credit Line = Classic marks these for xUSD). Likely expense. Uncertain. |
| Input +, Output +, `Earn Adjustment Flex Term` | 4 | Adjustment credit. Uncertain. |
| Input 0, Output 0, Output Currency `-` | 2 | Zero-value rows (the one identical-content pair). Ignore. |
Conclusion: the Interest type is NOT one economic event; the sign of Input (and Credit Line) must drive the classification. Do not treat all Interest rows as income.

Ordering: this export is newest-first (first row 2026-10, last row 2019-03). Sort after parsing; do not rely on file order.

## File 2: futures export (`nexo_futures_transactions.csv`)

Format facts
- 4,670 data rows, 18 columns, no BOM, LF line endings, NO quoting at all (0 quoted fields), no wrong-width rows.
- Header has a LEADING SPACE on the first column name: `" Id"` (must trim header names). Header: ` Id, Timestamp, Symbol, Type, Position, Price, Amount, Status, Asset, Side, DealId, InternalTransactionType, TradingFeeAmount, TradingFeeAsset, ExecutionPriceAsset, ExchangeRate, SourceAsset, SourceAmount`.
- Literal token `null` (string) is used for missing values: Position (3,894), Status (4,183), Price (4,183), TradingFeeAmount (4,183), ExchangeRate (all 4,671), SourceAsset (all), SourceAmount (all). `Symbol` is `null` in 49 rows. `ExecutionPriceAsset` is an EMPTY string in 49 rows (otherwise USDT). Side is `null` in 49 rows.
- `Timestamp`: epoch milliseconds, 13 digits, all rows. Range 2023-12 to 2026-09. File order is DESCENDING by timestamp (0 ascending steps, 4,670 descending).
- `Id`: unique (4,671 distinct incl. all rows). Shapes by length: 8 digits numeric (4,088), 9 digits numeric (95), opaque alphanumeric 21 chars (73) or 22 chars (415). ORDER rows (MARKET_OPEN/CLOSE) have `Id == DealId` in all 488 rows.
- `DealId`: never empty. 3,318 distinct values. 13-digit numeric (3,845 rows; the funding rows - looks epoch-ms-like, differs from the row Timestamp by < 1 hour, never equal) or 21/22-char alphanumeric opaque ids (for non-funding deals). Not unique per row: shared by rows of the same deal/funding event.
- Numerics: plain decimals when present, Price and Amount cells can carry up to 16 dp (float noise from the exporter), TradingFeeAmount up to 6 dp. The decimal validator therefore allows up to 20. No separators or symbols.
- `Side` casing is inconsistent: `LONG`/`SHORT` (funding rows) and `long`/`short` (order, pnl and liquidation rows) - normalise case.
- Symbols: 46 distinct, all `<BASE>USDT` perpetuals (e.g. 1000BONKUSDT), plus `null`. `Asset` is `USDT` for TRANSACTION rows and the base ticker for ORDER rows. Fee asset is always USDT. Execution price asset is USDT.
- No content duplicates (ignoring id: 0 duplicate rows). No lead/trail whitespace in cells (header aside).

### Type / InternalTransactionType / Status combinations
| Type | Internal | Status | Rows | Position | Side | Amount sign | Price/Fee | Meaning (guess) |
|---|---|---|---|---|---|---|---|---|
| FUNDING_FEE | TRANSACTION | null | 3,845 | null | LONG/SHORT upper | mixed (+805 / -3,040) | Price 0, Fee 0 | Periodic perpetual funding payment on an open position, USDT. Negative = paid, positive = received (guess; sign by side is consistent with this). Many rows share one DealId (one funding event across positions). |
| REALIZED_PNL | TRANSACTION | null | 247 | close (244) / null (3) | long/short lower (null x3) | mixed (+127 / -119 / 0 x1) | Price 0, Fee 0 | Realised profit/loss credited on position close, USDT. 244 pair with a MARKET_CLOSE (same DealId). 3 rows have null symbol/position (belong to LIQUIDATION_FEE deals with no MARKET_CLOSE row). |
| MARKET_OPEN | ORDER | PLACED | 244 | open | long/short | + (base asset qty) | Price +, Fee + | Position opened at market. Amount is in the base asset, Price in USDT. |
| MARKET_CLOSE | ORDER | PLACED | 198 | close | long/short | + | Price +, Fee + | Position closed at market by the user. |
| MARKET_CLOSE | ORDER | LIQUIDATED | 46 | close | long/short | + | Price +, Fee + | Position force-closed by liquidation. |
| LIQUIDATION_FEE | TRANSACTION | null | 48 | close (45) / null (3) | long/short (null x3) | + | Price 0, Fee 0 | Liquidation fee charged (USDT), amount positive (cost or credit sign ambiguous - guess: expense). 45 attach to a liquidated MARKET_CLOSE deal; 3 attach only to a REALIZED_PNL row. |
| TRANSFER_TO_WALLET | TRANSACTION | null | 43 | null | null | + | Price 0, Fee 0 | Transfer of USDT between wallets (symbol null). Cross-file duplicate of transactions-file `Transfer To Advanced` (see below). Direction ambiguous from the name; amounts positive. |

Position/deal structure
- Open and close do NOT share a DealId: each of 244 MARKET_OPEN deals contains only that order row; each of 244 MARKET_CLOSE deals contains the close order + its REALIZED_PNL row (kind "CP" x244; kind "O" x244). 0 close DealIds equal an open DealId. So positions cannot be rebuilt by DealId grouping alone; pair opens to closes by Symbol + Side + time (open qty vs close qty) if lot matching is wanted.
- Realized PnL appears as its own rows (REALIZED_PNL, USDT), paired with the close by DealId. Liquidations appear as MARKET_CLOSE with Status LIQUIDATED, a REALIZED_PNL row and (45 of 46) a LIQUIDATION_FEE row in the same deal.
- Funding rows: DealId groups 1-6 funding rows (2,523 single-row deals, 531 with 2 rows, ... max 6); DealIds of funding rows never match any order DealId.
- Open orders 244 = close orders 244 (198 placed + 46 liquidated): every opened position in the file is closed.

## Cross-file overlap
- Transactions `Transfer To Advanced` (43 rows) vs futures `TRANSFER_TO_WALLET` (43 rows): each of the 43 transaction rows pairs with exactly one futures row within 2 minutes and with equal absolute amount (43/43 on both tests). These are the same economic event in both files. Importing both files without suppressing this would double count the Savings-to-Futures transfer (as an internal transfer it should net to zero in a combined view).
- No other futures Type has a transaction-file counterpart by name (the `Advanced Trading ... Bonus` Types have no futures-file rows).
- Date ranges overlap only from 2023-12; transactions file covers 2019-03 to 2026-10, futures 2023-12 to 2026-09.

## Parser implications (summary)
- Two distinct file shapes; detect by header (after trim): futures has `DealId`, transactions has `Transaction` and `Date / Time (UTC)`.
- Handle: all-quoted fields, `$`-prefixed USD equivalent, literal `-` and `null` as nulls, leading-space header, epoch-ms timestamps, mixed-case Side, non-chronological order, 22-char opaque ids vs numeric ids.
- Dedupe key: `Transaction` (txn file) and `Id` (futures file); do not dedupe on content. Row identity is per-file; the cross-file transfer pairing is a separate concern.
- Internal moves (Transfer*, Locking/Unlocking Term Deposit, bonus transfers) are not income/expense and should map to a non-P&L type.
