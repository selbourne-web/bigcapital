# Pionex live read-only probe (2026-10-07)

Method: signed GET calls only, from throwaway node scripts (Node 18.16.1, global fetch, host `https://api.pionex.com`, `redirect: 'error'`), run from the scratchpad directory, never from the repo. The owner's read-only key was read from the gitignored `.env` by the script itself (variables `PIONEX_EXCHANGE_API_KEY` / `PIONEX_EXCHANGE_SECRET_KEY`). This document records field names, types, enum values, counts and timings only: no balances, amounts, prices, ids, names or trade details. Calls were spaced at least 800 ms apart; no HTTP 429 was seen. Timestamp sent = `Date.now() - 1000`.

Calls made (all GET): `account/balances` x1, `wallet/balancesFull` x1, `common/symbols` x1, `trade/fills` x18 (13 valid symbols, 4 invalid, 1 without symbol; 3-year window), `trade/allOrders` x11 (10 with symbol, 1 without), `bot/orders` x2 (running, finished), `market/tickers` (public, unsigned) x1. See section 9 for the four unintended `TRADE_INVALID_SYMBOL` replies.

## 1. Signing and auth

- The documented scheme works live: `PIONEX-KEY` / `PIONEX-SIGNATURE` headers, `timestamp=now-1000`, signature = hex HMAC-SHA256(secret, `GET` + path + `?` + sorted `k=v` joined by `&`). The key authenticated on the first call and on every later call (`result: true`).
- Envelope on success: `{result: boolean, data: object, timestamp: int(epoch ms)}`. Key order varies between responses (do not depend on it).
- **Official test vector does NOT reproduce.** The official authentication page (fetched via WebFetch, verbatim, twice) prints secret `NFqv4MB3hB0SOiEsJNDP9e0jDdKPWbDqS_Z1dbU4`, string-to-sign `GET/api/v1/trade/allOrders?limit=1&symbol=BTC_USDT&timestamp=1655896754515` and signature `ec83d21e1237cbe7e0172f79c0e3a4741c86f6b201ba762f21149bf195519be1`. Note: the secret `NFqv4MB3...` quoted here is the vendor's PUBLISHED example secret from the authentication page, not a credential of ours. Computing HMAC-SHA256 hex of that exact string with that exact secret (Node crypto) gives `25dbbd2a6478ec4870653249d644cfb246eee4da347645cc98373f275e189242`. I also tried variants (parameter order, no `?`, leading slash, space after GET, trailing newline/space, base64-decoded secret, secret plus newline) and none gives the printed signature. The vendor example is therefore stale or wrong, while our implementation of the scheme is proven by live authentication. Recommendation for the Task 2 unit test: pin the independently derived value `25dbbd2a...e189242` for the vendor inputs (document that the vendor page prints a different, non-reproducible value) and additionally test the sorted-query/`timestamp` handling with a second synthetic vector.

## 2. Response headers and latency

- Rate-limit headers exist on every response: `x-ratelimit-tokens` (observed 29 after weight-1 calls, 25 after weight-5 calls; looks like a refilling token bucket) and `x-ratelimit-last` (float epoch seconds). No `retry-after` seen. Other headers are generic (`x-request`, envoy timing). The adapter can log `x-ratelimit-tokens` but should not depend on it.
- Latency (ms, single samples): account/balances 1206 (first call, cold connection), wallet/balancesFull 187, common/symbols 302, trade/fills 140 to 590 (mostly ~145), trade/allOrders ~140 to 280, bot/orders 440 (running) and 168 (finished), market/tickers 264.

## 3. GET /api/v1/account/balances

`data: { balances: array[N] of { coin: string, free: string(decimal), frozen: string(decimal) } }`. N = 8 on this account; all 8 had non-zero `free`, none non-zero `frozen`. Zero balances are not necessarily excluded by the API, so filter zero and negative values client-side. Coin codes are mostly uppercase; one coin has a mixed-case code (shape: one lowercase letter followed by uppercase letters). No pagination.

## 4. GET /api/v1/wallet/balancesFull (full shape)

```
data: {
  totalInUsdt: string(decimal), totalInBtc: string(decimal),
  circuitBreakerTag: null,
  botAccount: { totalInUsdt: string(decimal), detail: array[4] of Segment },
  traderAccount: { title: string, totalInUsdt: string(decimal), detail: array[1] of {
      type: string ("trader_account"), title: string (empty here), totalInUsdt: string(decimal),
      riskState: string ("TRADING"), balances: null, positions: null,
      quoteRisks: array[1] of { quote: string ("USDT"), assetsMarginMode: string ("MULTI"),
        multiModeEquity, multiInitMargin, multiMaintMargin: string(decimal), riskState: string } } },
  extractBalances: { propTrading: { coins: null },
                     trialFundCoupon: { coins: array[1] of SpotCoin } },
  prices: map<lowercase coin code, { fullName: string, priceInUsd, priceInBtc, change24hInUsd, change24hInBtc: string(decimal) }>
}
Segment = { type: string, title: string, totalInUsdt: string(decimal), list: array | null, hasMore: boolean, count: int, timestamp: int(epoch ms) }
```

Segment `type` values observed (botAccount.detail): `trading_bot` (title "Trading bot"), `spot` (title "Spot Balances"), `arbitrage` (title "Arbitrage"; **`list` is `null`**, count 0), `lending` (title "Earning"). Segment key order differs per element. `hasMore` was false and `count` equalled the list length everywhere; the API gives no cursor for `hasMore: true`, so treat it as a warning only.

List entries per segment type:

- `spot`: `SpotCoin = { coin: string, displayName: string, free: string(decimal), frozen: string(decimal), assets: string(decimal), frozenByOrder: string(decimal), frozenByMoveout: string(decimal), frozenByCoinout: string(decimal), debts: string, loan: string, payable: string, interest: string }`. Verified relations on all 8 entries: `assets == free + frozen` and `frozen == frozenByOrder + frozenByMoveout + frozenByCoinout`. Note `debts/loan/payable/interest` are plain strings (not always decimal-shaped; do not parse them as money).
- `trading_bot`: `{ buOrderId: string(uuid), buOrderType: string, title: string, cateType: string (empty), copyFrom: string (empty), investmentToken: string (uppercase coin code), investmentAmount: string(decimal), profit: string(decimal), baseList: array[1] of string }`. Observed `buOrderType`: `futures_grid`, `grid_v3`. `baseList` elements are plain strings (coin codes), not objects.
- `lending` (earn): `{ productId: string(digits), title: string, investmentToken: string, investmentAmount: string(decimal), profit: string(decimal), trialFund: string(decimal) }`.
- `arbitrage`: no entries (list null); shape unknown.
- `extractBalances.trialFundCoupon.coins[]` has the same shape as a `spot` entry (assets zero here and the coin also appears in the trading account).

Reconciliation tests (programmatic, ratios printed only):

- Coin sets: `account/balances` has 8 coins, `balancesFull` spot segment has 8; case-insensitive sets are identical (7 exact matches, 1 differs only in letter case). For the 7 exact matches `free` equal on 7 of 7 and `frozen` equal on 7 of 7. **Conclusion: the spot segment of balancesFull is a repeat of the trading-account balances, i.e. it must NOT be added to `account/balances`.**
- Segment totals: `top.totalInUsdt` = spot + trading_bot + lending + trader (ratio 1.0000), and `botAccount.totalInUsdt` = sum of its four segments (ratio 1.0000). Spot total = sum(assets x priceInUsd) (ratio 1.000), so the spot segment contains only trading-account funds.
- Bot value: segment `trading_bot` totalInUsdt = sum((investmentAmount + profit) x priceInUsd(investmentToken)) (ratio 1.0000); without `profit` the ratio is 0.68. All five bot entries have `investmentToken` USDT (also in the trading balances) and are `futures_grid` / `grid_v3` bots; so USDT locked in bots is NOT in `account/balances` while the same coin does appear there for free funds (separate funds, no double counting by value). `profit` can be non-zero for all entries (sign not guaranteed; treat as signed).
- Lending value: segment totalInUsdt = sum((investmentAmount + profit) x price) (ratio 1.0000, `trialFund` was zero so its treatment is unverified).
- `prices` only contains the account's held coins (13 keys here, keys lowercase, 3 of them with a `.perp` suffix). The keys are not a symbol source.

## 5. GET /api/v1/common/symbols

`data: { symbols: array[411] of { symbol: string, type: string, baseCurrency: string, quoteCurrency: string, basePrecision: int, quotePrecision: int, amountPrecision: int, minAmount, minTradeSize, maxTradeSize, minTradeDumping, maxTradeDumping, buyCeiling, sellFloor: string(decimal), enable: boolean } }`.

- `type` values: only `SPOT` (411 of 411); no PERP entries here. `enable`: true 340, false 71 (disabled by quote: USDT 67, USDC 3, ETH 1). Disabled markets are still listed.
- Count by quote coin: USDT 389, BTC 10, ETH 7, USDC 5.
- Symbol format `BASE_QUOTE` (e.g. shape `X_X`). In 4 spot rows `symbol` is NOT equal to `${baseCurrency}_${quoteCurrency}` (one token carries a lowercase prefix letter, shape `xX_X`). **Use the `symbol` field verbatim; never rebuild it from base/quote.**
- Held-coin coverage: of the 8 held coins, 7 have at least one enabled SPOT market (counts per coin 1 to 3) and 1 has none. Bot coins are `.PERP` bases which have no spot market.

## 6. GET /api/v1/trade/fills and /api/v1/trade/allOrders

**Live shapes NOT verified: every probe returned an empty list.** I tried `fills` on all 10 spot markets of the held non-stable coins, on 3 majors (3-year window `startTime`..`endTime`), and `allOrders` (limit 200) on the 10 held-coin markets: all returned `result: true` with `data: { fills: [] }` / `data: { orders: [] }`. This account's activity is bot-only (futures grid bots), which the API excludes. So nothing live is known about ordering, the 100-row cap, status/role enums or number types. Verified live: the empty envelopes (`fills` / `orders` keys present, array length 0) and that a 3-year window plus `limit=200` is accepted.

Spec-only information (official OpenAPI `openapi.yaml`, read via WebFetch, unverified live):

- Fill: `id` integer, `orderId` integer, `symbol` string, `side` BUY|SELL, `role` TAKER|MAKER, `price`/`size`/`fee` strings, `feeCoin` string, `timestamp` integer (ms); newest first; latest 100 returned beyond the cap.
- Order: `orderId` integer, `symbol`, `type` LIMIT|MARKET, `side`, `price`/`size`/`amount`/`filledSize`/`filledAmount`/`fee` strings, `feeCoin`, `status` **OPEN|CLOSED only**, `IOC` boolean, `clientOrderId` string, `source` MANUAL|API, `createTime`/`updateTime` integer (ms); doc says "maximum 200 open orders per symbol".
- Parameters sent: `symbol`, `startTime`, `endTime` (ms), `limit` (allOrders). Exact boundary semantics (inclusive `endTime`, rows tied at one millisecond) could not be tested.

No-symbol behaviour (natural single try each, both returned **HTTP 200**): `{ result: false, code: "TRADE_PARAMETER_ERROR", message: "empty `symbol`" }` for `fills` and for `allOrders`. So a missing symbol is not an HTTP 4xx.

## 7. GET /api/v1/bot/orders (Bot reading permission; the key had it)

`status=running` returned 3 rows and `status=finished` 2 rows (all `futures_grid`). Shape: `data: { results: array of Bot, nextPageToken: null, previousPageToken: null }`, `Bot = { buOrderId: string(uuid), buOrderType: string, status: string, base: string, quote: string, exchange: string, userId: string, keyId: string, strategyId: string(digits), createTime: int(epoch ms), closeTime: int|null, closeNote: null, note: null, copyFrom: null, copyType: null, customizeName: null, canceling: boolean, buOrderData: object(~127 keys, strings of decimals mostly) }`.

- `buOrderType`: `futures_grid` (the balancesFull list also shows `grid_v3`). `status`: `open` (running), `canceled` (finished). `exchange`: `pionex.v2`. `base` for futures bots has the shape `COIN.PERP` (not a spot symbol: using it as `<base>_<quote>` for fills gave `TRADE_INVALID_SYMBOL`, section 9). `quote` is a coin code (USDT or a coin like ADA for the finished ones).
- `buOrderData` is bot-type specific, with ~127 keys mixing names such as `investCoin`, `usdtInvestment`, `quoteInvestment`, `baseInvestment`, `totalRealizedProfit`, `gridProfit`, `totalFee`, `totalFundingFee`, `leverage`, `marginBalance`, `liquidationPrice`, `createTime`. It is not stable enough for a ledger; do not parse beyond what the plan needs.
- Pagination: `nextPageToken` null on both (token pagination exists, not exercised). The call worked with Bot reading, so `inspectKey` can report `bot-read`.

## 8. GET /api/v1/market/tickers (public, unsigned)

`data: { tickers: array[328] of { symbol: string, time: int, open, close, high, low, volume, amount: string(decimal), count: int } }`. Not needed for the sync (prices come in `balancesFull.prices`, only for held coins).

## 9. Errors and surprises

- Application errors use HTTP **200** with `{ result: false, code, message }` (seen: `TRADE_PARAMETER_ERROR` "empty `symbol`", `TRADE_INVALID_SYMBOL` "symbol not support"). The OpenAPI text lists 400/401/429, so auth failures may use 401 but this was not observed. The adapter must check `result === false` on any HTTP status before treating a body as data, and map `code` regardless of status.
- Four unintended `TRADE_INVALID_SYMBOL` replies: I derived symbols from bot `base` values (`COIN.PERP`) which are not spot markets. No harm (reads), but the adapter must never derive fills symbols from bot rows.
- `account/balances` and balancesFull coin codes can differ in case for the same coin; compare case-insensitively.
- Key permission set was not testable (no negative control); `bot/orders` succeeded.

## 10. Facts-doc and plan assumptions: wrong or unspecified

1. Facts 3.3 says `balancesFull` `list` entries are undocumented: now documented above; the `spot` segment REPEATS the trading account (adding it double counts every coin), `arbitrage.list` can be `null`.
2. Facts say bot funds may appear "only as USDT totals per category": wrong, per-bot entries carry `investmentToken`/`investmentAmount`/`profit`, but only in the investment token (here USDT); `baseList` is an array of strings, not objects.
3. Plan: "official vendor test vector must be a unit test with the printed signature": the printed signature is not reproducible (section 1).
4. Plan/facts imply errors are non-200; they were HTTP 200 with `result: false` (section 9).
5. Facts: `allOrders` status enumeration for "one immutable raw row per order status transition": the documented status enum has only OPEN and CLOSED (and no cancel/partial distinction), so `order:<id>:s<status>` yields at most two rows per order. Unverified live.
6. Plan: "symbol enumeration from `knownAssets` or `common/symbols`": symbols include 71 disabled markets and the format is not always `BASE_QUOTE`; held-coin enumeration found 10 spot markets for 8 coins (one coin has none), so the per-sync call count is small for this account but unbounded in general (budget needed).
7. Not verified live (account has no spot trades): fills/orders field names, id types (spec: integers; plan assumes string ids), 100-row cap, ordering, role/status enums, number types, `endTime` inclusivity.
8. Rate-limit headers `x-ratelimit-tokens` / `x-ratelimit-last` exist (not mentioned in facts).

## 11. Recommendations for Tasks 2 and 3

- **Balances merge rule (no double count):** base = `account/balances` (free + frozen per coin, uppercase-normalize the coin code, skip zero/negative). Add from `balancesFull.botAccount.detail` ONLY the segments `trading_bot` and `lending`: per entry add `(investmentAmount + profit)` (exact decimals, signed `profit` allowed, skip entry if the sum is negative or not decimal) to coin `investmentToken` (uppercase) as separate "bot" / "earn" components, never merging into the spot component without keeping them separately visible. Ignore segments `spot` and `arbitrage`, `traderAccount` (null balances here; futures equity is out of scope), `extractBalances` (trial funds) and `prices`. Unknown segment types, a `null` list or an unparseable entry are skipped (record as warning), never fail the sync. If `balancesFull` fails with a non-auth error, return the spot balances with a warning. Futures-grid `investmentAmount + profit` is an equity estimate that moves with the market, flag it as such. `trialFund` handling is unverified: exclude it.
- **Symbol enumeration:** `common/symbols`, filter `type === 'SPOT'` and `enable === true`, keep `symbol` verbatim; select markets whose base or quote matches a held/previously-seen coin (case-insensitive); fall back to previously-seen symbols for delisted markets. Never use bot `base`/`quote`, `prices` keys, or `COIN.PERP` values. Cap the markets per sync and persist progress (fills/orders cost weight 5, 600 ms gap).
- **Record ids:** coerce `id` / `orderId` with `idText` (spec says integers, so allow number or string; never treat large numbers as floats: parse the response text with a numeric-safe approach or at least tolerate precision loss warnings). Order rows: `order:<orderId>:s<status>`; because only OPEN/CLOSED exist, tolerate any other status string rather than throwing.
- **Number types:** per spec, price/size/fee/amount are strings and `timestamp`/`createTime`/`updateTime` integers; use `quoteExactNumbers` anyway and unparsed-row fallback. Live proof is outstanding (re-run the probe when the owner has a manual spot trade, or use the sanitised spec-derived fixtures marked as "spec-derived, not live").
- **Error handling:** check the envelope first, map `code` from HTTP-200 bodies, then HTTP 401/429/5xx; treat `TRADE_PARAMETER_ERROR` / `TRADE_INVALID_SYMBOL` for one market as non-fatal for that market (skip with warning), not a whole-sync failure.
- **inspectKey:** `bot-read` can be derived from a successful `bot/orders?status=running` (worked); permission probes must stay non-propagating.

## Symbol collisions

- **`METH` is milli-ETH on Pionex** (1 mETH = 0.001 ETH, market `METH_USDT`, about $2.58), not Mantle Staked ETH (about $2,811) which the price feed calls `METH`. Pionex `METH` is stored as the distinct asset `MILLIETH` (`PIONEX_ALIASES` in `adapters/assets.ts`), quantities unrescaled, and priced via ETH x 0.001 (`UNIT_WRAPPERS` in `assets.ts` and the webapp `valuation.ts`). Market symbols stay the raw `METH_USDT`. The next Pionex sync writes `MILLIETH`; `writeSnapshot` then zeroes the stale `METH` row.

## 12. Secret scan

Programmatic scan (done before the commit) of this document and all captured script output files in the scratchpad for the key and secret substrings: zero hits. Raw response files used for analysis were deleted from the scratchpad after the probe.
