# Piece 2: exchange API facts (Crypto.com Exchange, Nexo Pro, Pionex)

Researched 2026-10-06. Web only: official docs, official GitHub, official help centres. No authenticated endpoint was called and no keys were used.

Confidence tags:
- **[V]**: verified in official docs (quoted or paraphrased from the cited official page or spec).
- **[I]**: inferred, or taken from a non-official source (named in the row).
- **[U]**: unclear or unverified. Do not code against it without confirming it first.

Target interface: `packages/server/src/modules/CryptoExchanges/adapters/ExchangeAdapter.ts` (`inspectKey`, `fetchBalances`, `fetchHistory(cursor, since, knownAssets)`, `rateLimit`).

---

## 1. Crypto.com Exchange (Exchange API v1)

The docs moved. The old `exchange-docs.crypto.com/exchange/v1/rest-ws/index.html` now returns a 301 redirect to `https://exchange-developer.crypto.com/` (a Docusaurus site). A machine-readable index is at `https://exchange-developer.crypto.com/exchange/v1/llms.txt`, and every page is also served as `.md`.

Abbreviations used for the sources below:
- CAR = https://exchange-developer.crypto.com/exchange/v1/docs/api/rest-common-api-reference
- API key page = https://exchange-developer.crypto.com/exchange/v1/docs/api/fix-api-key
- Endpoint pages = `https://exchange-developer.crypto.com/exchange/v1/docs/api/rest/<method-with-dashes>`

### 1.1 Transport and auth

| Item | Fact | Source | Conf |
|---|---|---|---|
| Prod REST | `https://api.crypto.com/exchange/v1/{method}` | CAR | V |
| UAT REST | `https://uat-api.3ona.co/exchange/v1/{method}` | CAR | V |
| WS user / market (prod) | `wss://stream.crypto.com/exchange/v1/user` and `wss://stream.crypto.com/exchange/v1/market` | CAR | V |
| WS (UAT) | `wss://uat-stream.3ona.co/exchange/v1/user` and `.../market` | CAR | V |
| HTTP method | Private endpoints are `POST` with a JSON body (`Content-Type: application/json`). `public/get-tickers` is `GET` with a query string. | endpoint pages; CAR | V |
| Body | `{ id (long), method, params (object, {} if none), api_key, sig, nonce (ms epoch) }` | CAR | V |
| Numbers | Quote: "All numbers must be strings, and must be wrapped in double quotes." | CAR | V |
| Signing | (1) Sort `params` keys ascending. (2) Concatenate key + value with no delimiters to build the param string. (3) Build `method + id + api_key + paramString + nonce`. (4) HMAC-SHA256 with the API secret. (5) Hex-encode. | CAR | V |
| Nested params | Official JS sample recurses into objects (keys sorted) and arrays (elements concatenated). Official Python and Java samples cap recursion at `MAX_LEVEL = 3`, `str()` anything deeper, and render `None` as `'null'`. Our read-only calls use flat params only. | CAR | V |
| Nonce | Must be within 60 s of server time (`40102 INVALID_NONCE: Nonce value differs by more than 60 seconds`). | CAR | V |
| Errors | `40101` UNAUTHORIZED, `40103` IP_ILLEGAL ("IP address not whitelisted"), `42901` TOO_MANY_REQUESTS (HTTP 429), `40104` USER_TIER_INVALID | CAR | V |

### 1.2 Key permissions and introspection

| Item | Fact | Source | Conf |
|---|---|---|---|
| Permission model | Quote: "Default settings will be set to 'Can Read' only, and you have the option of adding or removing certain permissions for your API Key via Web UI." The UI exposes trade and withdrawal toggles; the docs do not enumerate them. | API key page; CAR | V (Can Read default) / I (exact toggle names) |
| Introspection endpoint | **None documented.** No GetApiKeyInfo equivalent exists in the full llms.txt index. `private/get-accounts` returns account and sub-account metadata (`hierarchy` MASTER/SUB_ACCOUNT, `tradable`, `derivatives_access`, `margin_access`), not key permissions. | llms.txt; `private-get-accounts` | V (absence in index) |
| Withdraw detection heuristic | `private/get-deposit-address` says: "Withdrawal setting must be enabled for your API Key." If that read-only call succeeds, the key has withdrawal enabled. If it fails with a permission error, withdrawal is probably off. The exact error code for "permission not granted" is not documented. | `private-get-deposit-address` | I |
| Trade detection | No safe read-only way to detect trade permission. Recommendation: `inspectKey` returns `readOnly: 'unverifiable'` unless the deposit-address probe shows withdraw is enabled, in which case it returns `false`. | derived | I |
| IP whitelist | Optional. Quote: "You can optionally specify a whitelist of IP addresses when generating the API Key. If specified, the API can only be used from the whitelisted IP addresses." | API key page | V |

### 1.3 Read-only endpoints for the adapter

| Need | Method | Key params | Pagination / window | Conf |
|---|---|---|---|---|
| Balances | `private/user-balance` (no params) | n/a | `data[]` with `total_available_balance`, `total_margin_balance`, `total_cash_balance`, etc., plus `position_balances[]` containing `instrument_name`, `quantity`, `market_value`, `reserved_qty`, `max_withdrawal_balance`, `collateral_amount`, `haircut` | V (schema props from embedded OpenAPI) |
| Sub-account balances | `private/get-subaccount-balances` | none | `data[]` per sub-account | V |
| Accounts | `private/get-accounts` | `page`, `page_size` (default 20) | page-based | V |
| Trades (fills) | `private/get-trades` | `instrument_name` (omit for all), `start_time`, `end_time` (ms or ns; ns "recommended for accurate pagination"), `limit` (default 100, max 100) | Time-window paging backwards from `end_time`. Default `start_time = end_time - 1 day`. No max window is stated. Response fields: `trade_id`, `order_id`, `instrument_name`, `side`, `traded_price`, `traded_quantity`, `fees` (negative = paid), `fee_instrument_name`, `fee_credits` (added 2026-04-29), `taker_side`, `create_time`, `create_time_ns`, `trade_match_id`, `journal_type` | V |
| Orders | `private/get-order-history` | same time params; `limit` default 100 | As above. Includes `cumulative_fee`, `fee_instrument_name`, `avg_price`, `status` | V |
| Ledger / journal | `private/get-transactions` | `journal_type` filter, `start_time`, `end_time`, `limit` (max 100) | Default 1 day. `journal_type` enum: TRADING, TRADE_FEE, ONCHAIN_WITHDRAWAL, ONCHAIN_DEPOSIT, FUNDING, REALIZED_PNL, INSURANCE_FUND, SOCIALIZED_LOSS, LIQUIDATION_FEE, SESSION_RESET, ADJUSTMENT, SESSION_SETTLE, UNCOVERED_LOSS, ADMIN_ADJUSTMENT, DELIST, SETTLEMENT_FEE, AUTO_CONVERSION, MANUAL_CONVERSION, SUBACCOUNT_TX, FIAT_WITHDRAWAL_CANCEL, MARGIN_TRADE_INTEREST. Fields: `journal_id`, `event_timestamp_ms/ns`, `transaction_qty`, `transaction_cost`, `realized_pnl`, `instrument_name` | V |
| Deposits | `private/get-deposit-history` | `currency`, `start_ts`, `end_ts` (ms), `page` (0-based), `page_size` (default 20, max 200), `status` (0 Not Arrived, 1 Arrived, 2 Failed, 3 Pending) | Page-based. Default start is "90 days from current timestamp". Fields: `id`, `amount`, `fee`, `create_time`, `update_time`, `currency`, `address`, `status` | V |
| Withdrawals | `private/get-withdrawal-history` | same, plus status 0 Pending, 1 Processing, 2 Rejected, 3 Payment In-progress, 4 Payment Failed, 5 Completed, 6 Cancelled | Page-based, default 90 days. Fields add `txid`, `network_id`, `client_wid` | V |
| Fiat | `private/fiat/fiat-deposit-history`, `private/fiat/fiat-withdraw-history` | paginated | Documented as being for FCM/DCM brokers; applicability to retail is unclear | V (exists) / U (retail) |
| Staking | `private/staking/get-staking-position`, `private/staking/get-stake-history`, `private/staking/get-reward-history` | `start_time`, `end_time`, `limit` (default 20, max 500) | Default `end_time - 30 days`. Quote: "Min: end_time - 180 days". Reward fields: `event_timestamp_ms`, `reward_inst_name`, `reward_quantity`, `staked_balance`, `underlying_inst_name` | V |
| Balance history | `private/user-balance-history` | `timeframe` H1 or D1; `limit` (D1 max 30, H1 max 120) | Total cash balance snapshots only. Useful for reconciliation | V |
| Trading bots | `private/bot/get-trading-bots`, `private/bot/get-trading-bot-executions` | `bot_types` required (DCA, TWAP, GRID, FUNDING_ARBITRAGE), `page_size` max 500 | Added 2026-05-21. Bot fills are presumably also in `get-trades` because they are ordinary exchange orders; this is not documented | V (endpoints) / I (bot fills in get-trades) |
| Public ticker | `GET public/get-tickers?instrument_name=` ; WS `ticker.{instrument_name}` on `/market` | n/a | Wildcard ticker WS subscription was removed (breaking-change schedule) | V |

### 1.4 Rate limits and retention

| Item | Fact | Source | Conf |
|---|---|---|---|
| Private REST | Per API method, per API key: `private/get-trades` 1 req/s; `private/get-order-history` 1 req/s; `private/get-order-detail` 30 per 100 ms; "All others: 3 requests per 100ms each" | CAR | V |
| Staking | 50 req/s each | CAR | V |
| Public | 100 req/s per method per IP | CAR | V |
| **Retention** | Quote: "History will be stored for recent 6 months record only. For records over 6 months, please contact our support team." Applies to the Transaction History group (trades, orders, transactions). Staking history cannot start earlier than `end_time - 180 days`. | https://exchange-developer.crypto.com/exchange/v1/docs/api/rest/transaction-history | V |

### 1.5 Gotchas

- `get-trades` and `get-transactions` page backwards: the caller moves `end_time` to the oldest `create_time_ns` returned. The docs recommend ns timestamps for exact paging. **[V]** (paging recipe derived)
- Recommended `rateLimit` for the adapter: the bucket must respect 1 req/s for `get-trades` and `get-order-history`. For example `capacity 1, refillPerSec 1`, or a separate per-method bucket. **[I]**
- Spot, margin and derivatives are a single unified wallet ("Smart Cross Margin"). `user-balance.position_balances` is the per-asset view. `quantity` can be negative under margin borrow. **[I]**
- Staked tokens appear as instruments such as `SOL.staked`, with liquid-staking conversions via `private/staking/convert` history. Map `X.staked` to X for pricing. **[V]** (naming) / **[I]** (mapping)
- Sub-accounts need their own keys, or the master key with `get-subaccount-balances` (balances only). Trade history per sub-account through the master key is not documented. **[U]**
- The Crypto.com **App** (consumer app, Earn) is a separate product with no API. It is out of scope here.

---

## 2. Nexo Pro (pro.nexo.com) and the Nexo main platform

### 2.1 Does a public API exist?

| Item | Fact | Source | Conf |
|---|---|---|---|
| API exists | The FAQ embedded in the official pro.nexo.com web bundle (`/static/js/main.23a1dfa4.js`, fetched 2026-10-06) says: "Is there an API for Nexo Pro? Yes, the API is open for users and third parties through both REST and Websocket… Each user can create up to 5 API keys." | https://pro.nexo.com (bundle) | V |
| Official docs location | Historically `https://pro.nexo.io/api-doc-pro`, later `pro.nexo.com/apiDocPro.html`. **Both now return only the SPA landing shell; the current router has no `api-doc-pro` route.** The only doc route is `/api-doc-prime`, which is private (login required, Nexo Prime). The Wayback Machine was offline when checked. **Official public docs could not be retrieved.** | pro.nexo.com bundle routes | V (unavailability) |
| GitHub | `github.com/nexofinance` has only `NEXO-Token` and `contract-metadata`. No API SDK or spec. | GitHub API | V |

Because no official docs could be retrieved, everything below in 2.2 comes from **unofficial** clients: `aussedatlo/nexo-pro` (npm `nexo-pro`, last pushed 2023-08) and `guilyx/python-nexo`. **Treat all of 2.2 as [I]/[U] and verify it against the official doc behind login before coding.**

### 2.2 API facts from unofficial clients (unverified)

| Item | Fact (per unofficial client) | Source | Conf |
|---|---|---|---|
| Base URL | `https://pro-api.nexo.io/api/v1` | aussedatlo/nexo-pro `src/constant/api.ts` | I |
| Auth headers | `X-API-KEY`, `X-NONCE` (ms timestamp), `X-SIGNATURE` | aussedatlo/nexo-pro `src/client.ts` | I |
| Signature | `base64(HMAC-SHA256(secret, nonce))`. Only the nonce is signed, not the path or body. | aussedatlo/nexo-pro `src/utils/rest.ts` | I |
| Balances | `GET /accountSummary` returns `balances[] {assetName, totalBalance, availableBalance, lockedBalance, debt, interest}` | both clients | I |
| Trades | `GET /trades?pairs=&startDate=&endDate=&pageSize=&pageNum=` returns `trades[] {id, symbol, side, tradeAmount, executedPrice, timestamp, orderId}`. No fee field appears in the client types. | aussedatlo types | I / U (fees) |
| Orders | `GET /orders` (same paging params), `GET /orderDetails?id=` | aussedatlo | I |
| Transactions | `GET /transaction?transactionId=` (lookup by id only; no list endpoint seen) | aussedatlo | I |
| Key roles | Third-party guide: when creating a key, "ensure that only the VIEWER role is selected". This suggests role-based keys (VIEWER vs trading roles). | https://help.recap.io/en/articles/10768282-connecting-your-nexo-pro-account (third-party) | I |
| Introspection | None found. | n/a | U |
| Rate limits | Not found. | n/a | U |
| Retention | Not found. | n/a | U |
| IP whitelist | Not found. | n/a | U |
| Deposits / withdrawals | No list endpoint was found. Nexo Pro's own web app uses internal session-cookie endpoints (`/api/v1/order/depositAndWithdraw`, `/api/v1/platform/deposit`, `/api/v1/platform/withdraw`, `/api/v1/balances/interests`, `/api/v1/export`). These are **not** the public key-based API and must not be used. | pro.nexo.com bundle | V (exist, internal) |

### 2.3 Nexo Pro vs Nexo main platform balances

| Item | Fact | Source | Conf |
|---|---|---|---|
| Separate wallets | The Nexo Pro terms text in the official bundle lists the right to "top up and withdraw Digital Assets from or to the Nexo Platform". On closure, "any remaining balance of Digital Assets will be moved to the Savings Wallet of your Nexo Account". The Pro wallet is therefore a **separate balance**, funded by internal transfer from the Nexo Savings wallet. Count each balance once and treat top-ups and withdrawals as internal transfers. | pro.nexo.com bundle | V (wording) / I (accounting implication) |
| Fixed-term funds | Active Fixed Term balances cannot be topped up to Pro until the term ends (from a search-engine summary; the source page was not retrieved). | n/a | U |
| Main platform API | **No public API** for Nexo earn and credit was found. Koinly's integration uses an SSO-based connection, not a user key. | https://nexo.com/blog/how-to-do-your-nexo-taxes-with-koinly | V (SSO wording) / I (no public API) |

### 2.4 Nexo main-platform CSV export (fallback)

| Item | Fact | Source | Conf |
|---|---|---|---|
| How | Quote: "log in to Nexo, and select transactions in the top menu… select a date range… all types and all assets… hit export" | https://nexo.com/blog/how-to-do-your-nexo-taxes-with-koinly | V |
| Columns (format since 2022-03-31) | `Transaction, Type, Input Currency, Input Amount, Output Currency, Output Amount, USD Equivalent, Details, Outstanding Loan, Date / Time` | https://discuss.koinly.io/t/nexo-csv-upgrade/13133 (community) | I |
| Newer fee columns | Some third parties list `Fee, Fee Currency`. Not confirmed. | n/a | U |
| Type values | Interest, Exchange, Deposit, Withdrawal, Cashback and similar are commonly seen. No official enumeration was found. | n/a | U |
| Timezone | Not documented. | n/a | U |
| Nexo Pro export | The Pro web app has its own Export screen (`/api/v1/export`; columns "Type / Format / Date Range"). It produces async files with a download link. File columns are unknown. | pro.nexo.com bundle | V (exists) / U (columns) |

**Recommendation:** the owner should export one real CSV from Nexo (main) and one from Nexo Pro, so the importer can be built against actual headers.

---

## 3. Pionex

Official sources:
- Docs: https://www.pionex.com/docs/api-docs (GitBook; index at https://www.pionex.com/docs/llms.txt; pages also served as `.md`).
- Official OpenAPI specs: https://github.com/pionex-official/pionex-open-api (last commit 2026-09-21; files `openapi.yaml`, `openapi_wallet.yaml`, `openapi_bot.yaml`, `openapi_earn*.yaml`, `openapi_futures.yaml`).
- Legacy docs: https://pionex-doc.gitbook.io/apidocs/

### 3.1 Transport and auth

| Item | Fact | Source | Conf |
|---|---|---|---|
| REST base | `https://api.pionex.com` | spec README; `restful/general/basic` | V |
| WS | Public `wss://ws.pionex.com/wsPub`; private `wss://ws.pionex.com/ws` (query auth: `key`, `timestamp`, `signature` over `PATH_URL + "websocket_auth"`) | spec README; `websocket/general-info` | V |
| Headers | `PIONEX-KEY`, `PIONEX-SIGNATURE`; query param `timestamp` (ms). Quote: "Any timestamp older than 20,000 milliseconds or in the future is invalid" | `openapi.yaml` info | V |
| Signing | (1) Take the ms timestamp. (2) Write query params as `key=value`, not URL-encoded. (3) Sort ascending ASCII by key, join with `&`, include `timestamp`. (4) `PATH + "?" + sorted`. (5) Prepend METHOD, e.g. `GET/api/v1/trade/allOrders?limit=1&symbol=BTC_USDT&timestamp=1655896754515`. (6) For POST/DELETE, append the raw JSON body. (7) HMAC-SHA256 with the secret, hex-encoded. Official test vector: secret `NFqv4MB3hB0SOiEsJNDP9e0jDdKPWbDqS_Z1dbU4`, ts `1655896754515`. | https://pionex-doc.gitbook.io/apidocs/restful/general/authentication | V |
| Envelope | `{result: bool, data, timestamp}`; on error `{result:false, code, message}` | `openapi.yaml` | V |
| Error codes | `APIKEY_LOST`, `SIGNATURE_LOST`, `IP_NOT_WHITELISTED`, `INVALID_APIKEY`, `INVALID_SIGNATURE`, `APIKEY_EXPIRED`, `INVALID_TIMESTAMP`, `PERMISSION_DENIED` | `openapi.yaml` | V |

### 3.2 Key permissions and introspection

| Item | Fact | Source | Conf |
|---|---|---|---|
| Permission set | Public; **Enable reading**; **Enable trading**; **Enable transfer** (`POST /api/v1/assets/transfer`); **Bot reading**; **Bot trading**; **Earn (Beta)**; plus institutional and internal permissions. No retail withdrawal permission appears in the API permission table. | https://www.pionex.com/docs/api-docs/references/api-key-permissions | V |
| Introspection | **None documented.** No endpoint returns a key's permissions. | permissions page; specs | V (absence) |
| inspectKey recommendation | `readOnly: 'unverifiable'`. The only permission detectable by a read call is reading (and Bot reading via `GET /api/v1/bot/orders`): a `PERMISSION_DENIED` there shows the permission is missing. Trading and transfer cannot be detected without a write. Do not probe with writes. | derived | I |
| IP whitelist | Recommended, not required. Quote: "It is recommended to set up an IP whitelisting along with API Key for security purpose." | https://pionex-doc.gitbook.io/apidocs/readme | V |
| Key expiry | The `APIKEY_EXPIRED` error exists, but the expiry rules are undocumented. Some exchanges expire non-IP-bound keys; this is not confirmed for Pionex. | `openapi.yaml` | U |

### 3.3 Read-only endpoints for the adapter

| Need | Endpoint | Params / paging | Conf |
|---|---|---|---|
| Trading-account balances | `GET /api/v1/account/balances` (Enable reading, weight 1) returns `balances[] {coin, free, frozen}` | Quote: "The balances only includes the balances of the trading account, excluding the balances of bots and earn account." | V |
| **All balances incl. bots** | `GET /api/v1/wallet/balancesFull` (Enable reading; the spec text also says "Trade reading"; weight 1). Covers "Spot (Bot Account) and Futures (Trader Account) dimensions, with price information for each coin and total USDT/BTC valuations". Shape: `botAccount.detail[] {type, title, totalInUsdt, list, hasMore, count}`, `traderAccount`, `prices{coin:{priceInUsd,...}}`. **The structure of `list` entries "depends on type" and is not specified.** | V (endpoint) / U (`list` schema) |
| Fills | `GET /api/v1/trade/fills?symbol=&startTime=&endTime=` (weight 5) returns `{id, orderId, symbol, side, role, price, size, fee, feeCoin, timestamp}` | **Per-symbol, required.** Quote: "When the number of orders in time range exceeds 100, return the latest 100 fills." No cursor: page by moving `endTime` back. Self-trades produce two records. Use `knownAssets` and symbols to enumerate. | V |
| Orders | `GET /api/v1/trade/allOrders?symbol=&startTime=&endTime=&limit=` (limit 1 to 200, default 50; weight 5). Includes `fee`, `feeCoin`, `source` | Quote: "The order page currently only supports SPOT non-strategic orders", meaning **bot orders are excluded** | V |
| Fills by order | `GET /api/v1/trade/fillsByOrderId` | n/a | V |
| Bots | `GET /api/v1/bot/orders?status=running\|finished&base=&quote=&pageToken=&buOrderTypes=` (Bot reading); per-bot `GET /api/v1/bot/orders/spotGrid/order`, `.../futuresGrid/order`, `.../smartCopy/order` | Token pagination (`nextPageToken`). Types: `futures_grid`, `future_hedge_grid`, `spot_grid`, `smart_copy`. **No per-fill bot trade history endpoint** was found; bot P&L is only available as bot-level summaries. **No DCA bot API.** | V |
| Internal transfers | `GET /api/v1/assets/transfers` (Enable reading; `limit` 1 to 100, default 20; weight 5) | in `openapi_futures.yaml` | V |
| Futures | `/uapi/v1/account/*`, `/uapi/v1/trade/historyOrders`, `/uapi/v1/trade/fills`, `/uapi/v1/trade/fundingFee` (Enable reading) | Futures API is Beta | V |
| Earn | `GET /api/v1/earn/dual/balances`, `GET /api/v1/earn/dual/records`, `GET /api/v1/earn/arbitrage/fetchUserBalances` | Beta | V |
| **Deposits / withdrawals** | **No retail endpoint.** Only institutional and invite-only ones (`/api/v1/instFund/common/getDeposits`, `getWithdraws`, `/api/v2/institution/asset/records`). | changelog https://www.pionex.com/docs/api-docs/readme/change-log | V (absence for retail) |
| Public ticker | `GET /api/v1/market/tickers?symbol=&type=SPOT\|PERP`; `GET /api/v1/market/bookTickers`; WS public `TRADE`/`DEPTH` topics | Symbols use `BTC_USDT` format | V |

### 3.4 Rate limits and retention

| Item | Fact | Source | Conf |
|---|---|---|---|
| Limits | Weighted. "All endpoints share the 10 per second limit based on IP. Private endpoints share the 10 per second limit based on ACCOUNT." On breach: HTTP 429 and a 60 s ban, extended by 10 s per further request. Fills and allOrders cost weight 5, so at most **2 per second**. | https://www.pionex.com/docs/api-docs/trade-api/general-info/rate-limits | V |
| Adapter config | Suggested `capacity 10, refillPerSec 10, historyPageCost 5`. **Never retry blindly after a 429, because each retry extends the ban.** | derived | I |
| Retention | No API retention limit is documented. | n/a | U |

### 3.5 Gotchas

- The API cannot reconstruct deposits, withdrawals or bot-internal fills. A complete Pionex history **requires the CSV fallback**. **[V]** (endpoint absence)
- Bot funds live in a separate "bot account". Only `balancesFull` shows them, and possibly only as USDT totals per category. **[V]** / **[U]** (per-coin breakdown)
- History endpoints are per-symbol, so the adapter must enumerate symbols (from `knownAssets` or `GET /api/v1/common/symbols`). **[V]**

---

## 4. CSV / export fallback formats

| Exchange | Export path and limits | Columns | Conf |
|---|---|---|---|
| Crypto.com Exchange | Six report types: Wallet Transactions History; Wallet Deposits & Withdrawals; Order History and Trade History; Lockup Rewards; Referral Rewards; Supercharger Rewards (copy-paste only). Wallet export window is at most 1 month; other reports up to 6 months; 65,000 records max per export; delivered via the "Export History" tab within 2 days. Quote: "Only transactions from 1 November 2022 onward are available." Monthly statements cover up to 36 months. | **Column names are not documented.** Timezone is not documented. Get a sample export. | V (process and limits) / U (columns). Source: https://help.crypto.com/en/articles/4837927-how-do-i-export-my-transaction-history-exchange |
| Nexo (main) | Transactions, then date range, all types, all assets, then Export | `Transaction, Type, Input Currency, Input Amount, Output Currency, Output Amount, USD Equivalent, Details, Outstanding Loan, Date / Time` (2022+ format). Interest, fees and rewards appear as `Type` rows. | I (community). See §2.4 |
| Nexo Pro | Separate in-app Export (async file). | Unknown | U |
| Pionex | Dashboard, then Transaction History, then a date range, then Submit. Delivered by email or SMS as a ZIP of several files (one is "for-cointracker"). Limits: 3 exports per month, up to 15 months per export, link ready within 24 h and valid for 7 days. Web data before 2022-01-01 may omit transaction types; use the app for that period. Export covers spot, bot trades, futures, fees. | **Column names are not documented.** | I. Sources: CoinLedger guide https://help.coinledger.io/en/articles/7175790-pionex-file-import-guide (limits); support.pionex.com article 18893610156825 returned HTTP 403 and could not be read. |

**Action for the owner:** export one sample file of each type from each exchange, so the CSV importer can be written against real headers and timestamp formats. None of the column sets are confirmed by official docs.

---

## 5. Dynamic home IP and rate-limit notes

| Exchange | IP allow-list | Impact on a dynamic home IP | Conf |
|---|---|---|---|
| Crypto.com | Optional per key. If set, other IPs get `40103 IP_ILLEGAL`. | Leave the allow-list empty, or front the server with a static egress IP. Detect `40103` and surface "key IP-restricted" to the user. | V |
| Pionex | Recommended, optional. `IP_NOT_WHITELISTED` error. IP-based rate limit of 10/s. | Same approach. Note `APIKEY_EXPIRED`; whether non-IP-bound keys expire is **not documented [U]**. | V / U |
| Nexo Pro | Unknown. | Unknown. Verify in the logged-in API Management UI. | U |

Clock skew tolerances: Crypto.com nonce ±60 s **[V]**; Pionex timestamp 20 s, and future timestamps are rejected **[V]**; Nexo is unknown. Keep the server NTP-synced. For Pionex, subtract about 1 s from the timestamp to avoid the future-timestamp rejection **[I]**.

---

## 6. Open items before coding

1. **Nexo Pro:** someone must log in to Nexo Pro, open API Management and the API doc, and confirm: base URL, signing, key roles (VIEWER), rate limits, history endpoints and fee fields. Until then, a Nexo Pro adapter would rest only on 2023-era unofficial clients.
2. **Crypto.com:** confirm the error code `private/get-deposit-address` returns when withdrawal permission is off, before using it as the withdraw-detection heuristic.
3. **Pionex:** confirm the `balancesFull` `list[]` entry schema per type (needed for per-coin bot balances), and confirm the API key expiry policy.
4. **CSV samples** from all three exchanges (§4).
