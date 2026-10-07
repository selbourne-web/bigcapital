# Crypto.com live read-only probe (2026-10-06)

Method: signed read calls only (GET on the App API, POST read methods on the Exchange API), from a throwaway node script (Node 18.16.1). No values recorded; field names, types, enums and counts only. Env vars used: CRYPTO_COM_APP_API_KEY / CRYPTO_COM_APP_SECRET_KEY (host wapi.crypto.com) and CRYPTO_COM_EXCHANGE_API_KEY / CRYPTO_COM_EXCHANGE_SECRET_KEY (host api.crypto.com/exchange/v1). Names were unambiguous and both keys authenticated first try.

## A. Crypto.com App API (wapi.crypto.com)

Auth as specified (Cdc-Api-Key / Cdc-Api-Timestamp / Cdc-Api-Signature = base64 HMAC-SHA256 of ts+METHOD+path+body, plus User-Agent) worked. No 429s seen.

### GET /v1/api-keys/current (key permission introspection EXISTS)
Response: `{ok: bool, api_key: {...}}`. api_key fields:
- id string, name null, description null, api_key string (public key id), token_type string ("hmac")
- scopes: array of string. Values on this key (7): `balance:read`, `fiat.bank_account:read`, `fiat.deposit:read`, `fiat.deposit:write`, `fiat.limits:read`, `fiat.withdrawal:read`, `market:read`
- weekly_trading_limit_in_usd string(decimal) (non-zero on this key), remaining_weekly_trading_limit_in_usd string(decimal) (non-zero)
- expires_at / created_at / updated_at ISO-8601 datetime, revoked_at null, status enum (`active`)
- Expiry: this key expires 90 days after creation (it was created today). App keys EXPIRE; the app should surface expires_at and warn before it lapses.
- No IP-rule field returned.

Classification: scopes are `<resource>:<read|write>`. Read-only = every scope ends with `:read`. This key holds `fiat.deposit:write`, so it is NOT strictly read-only, but it holds no trade or withdrawal write scope among those seen. A non-zero weekly_trading_limit_in_usd is reported even though no trade scope is present, so the limit is key-level metadata, not proof of trade ability. Recommended rule: reject any scope not ending in `:read`; this key would be rejected as "not read-only" until the owner regenerates it without `fiat.deposit:write`. Names of other write scopes (trade, crypto withdrawal) were not observed; use the `:write` suffix rule.

### GET /v1/crypto-account
`{ok, account: {id number, native_currency string, balance{currency,amount}, native_balance, total_native_available_balance, amount_change, percentage_change string(decimal), accounts_summary[{account_id,account_type,has_balance}], wallets[...]}}`.
wallets: 1955 entries (every listed asset, most zero). Entry: currency, balance / native_balance / available / native_available / locked / native_locked / display_balance / display_available / display_locked (each `{currency, amount string(decimal)}`), locked_until null, percentage_change, address null|string, major_wallet bool, networks[{name,short_name,network_id,address}], travel_rule_unrealized{currency, amount number}, native_travel_rule_unrealized. Filter to non-zero balances; native_balance gives the fiat valuation directly. Staked/earn holdings are not clearly separated here (see /v1/portfolio products).

### GET /v1/fiat-account
`{ok, account: {fees{year_to_date,last_month}, balance, native_balance, viban_types[10]{type enum(ar_debin|au_npp|br_cmp|br_doc|br_pix|br_ted|ca_interac_etransfer|sg_fast|uk_fps|usd_swift), name, symbol, currency, state enum(created|pending_create|pending_submit), amount, native_amount, ...}, balances[1]{currency, amount, native_amount, total_amount, unsettled_amount, settled_amount, enabled_viban_types}, cash_wallets[1]{id, type enum(checking_account), sub_type, currency, amount, native_amount, total_amount, unsettled_amount, settled_amount, ...}, pending_terms[], banners[], accounts_to_add[], disclosure null}}`. All amounts are `{currency, amount string(decimal)}`.

### GET /v1/portfolio
`{ok, price_native{currency,amount}, coins[10]{id string, amount{...}, price_native{...}, percentage string(decimal), optional percent_change_native, name, slug, rank number, token_type, icon urls}, products[10]{name enum, price_native, percentage, product_name_translation_key}}`.
products.name enum seen: Airdrop Arena, Crypto Basket, Crypto Staking, Crypto Wallet, Defi Staking, Dual Invest, Earn, Exchange, Supercharger, Tokenised Stock Earn. This gives the per-product split (wallet vs earn/staking vs exchange) in native fiat, useful for detecting staked balances absent from wallets and for the "Exchange" slice that overlaps the Exchange connector (double-count risk).

### GET /v1/transactions
Pagination is cursor based. Response `{ok, transactions[], meta:{pagination:{total number, next:{last_id string, count number, pagination_key string, sort_by string ("id"), order enum ("desc")}}}}`.
- `count` query param works (`?count=N`); `limit` and `per_page` are ignored (default page = 20). count=100 was clamped to 50 (max page size 50).
- Next page: pass last_id, count, pagination_key, sort_by, order from `meta.pagination.next` as query params. When `next` is absent the end is reached (10 pages of 50 gave 493 records, ended cleanly). `total` is not reliable (it returned a tiny constant).
- Ordering: newest first (id desc).
- Retention: effectively full history. Oldest record is about 2735 days (7.5 years) old; newest 2 days old.
- Item fields: id string(numeric), account_id string, account_type string (`main`), context string (`crypto`), nature string, kind string, description string, user_uuid string, rate string(decimal), rate_desc null, amount{currency,amount}, native_amount{currency,amount} (USD equivalent at the time), native_currency, note null, address null, meta object (program/pool ids etc., variable), status enum (`done` only seen), created_at / updated_at ISO datetime, fee{amount,currency} (zero in all 493 records), execute_rate[{currency,amount}], source_id string, source_type string, encoded_id string, icons[], native_amount_32dp.
- Observed `nature`: admin_wallet_credit, crypto_wallet_swap, deposit, dpos, income, payment, rewards_platform_deposit_credit.
- Observed `kind`: admin_wallet_credited, crypto_deposit, crypto_to_exchange_transfer, crypto_wallet_swap_credited, crypto_wallet_swap_debited, exchange_to_crypto_transfer, finance.dpos.non_compound_interest.crypto_wallet, finance.dpos.staking.crypto_wallet, rewards_platform_deposit_credited.
- Observed `source_type`: airdrop, crypto_deposit, crypto_wallet_conversion, crypto_wallet_internal_credit, dpos_interest, dpos_staking, (empty string).
- Observed `context`: crypto only. Observed `status`: done only. Not present in this account, so enums unknown: withdrawals, card spend, fiat movements, cashback, other statuses.
- It DOES include deposits, staking (dpos), staking interest/rewards, airdrops, swaps (paired credited/debited rows) and App<->Exchange transfers (`crypto_to_exchange_transfer` / `exchange_to_crypto_transfer`), which are the internal-transfer / double-count case between the two connectors. Fee object is present but zero everywhere here.

## B. Crypto.com Exchange API (api.crypto.com/exchange/v1)
Signing per the docs worked first try (code 0 on every call).

- private/user-balance: `result.data[1]{total_risk_exposure, total_available_balance, total_margin_balance, total_initial_margin, total_haircut, total_position_im, total_maintenance_margin, total_position_cost, total_cash_balance, total_collateral_value, total_session_unrealized_pnl, total_session_realized_pnl, instrument_name, total_isolated_cash_balance, total_effective_leverage, position_limit, used_position_limit, total_borrow (all string(decimal)), credit_limits[], isolated_positions[], is_liquidating bool, has_risk bool, terminatable bool, position_balances[4]{quantity, reserved_qty, collateral_amount, haircut, market_value, max_withdrawal_balance, hourly_interest_rate (string decimal), collateral_eligible bool, instrument_name}}}`.
- private/get-accounts: `{master_account{uuid, user_uuid, enabled, tradable, name, country_code, phone_country_code, incorp_country_code, margin_access enum(DEFAULT), derivatives_access enum(DEFAULT), create_time number, update_time number, two_fa_enabled, kyc_level enum(ADVANCED), suspended, terminated, spot_enabled, margin_enabled, derivatives_enabled, account_locked number, onboarding_entity}, sub_account_list[0], this_account{uuid, hierarchy enum(MASTER)}}`. Contains PII (holder name, country); never log it. This is account metadata, not key permissions.
- private/get-deposit-history (no params): `result.deposit_list[7]{currency, fee number, create_time number(ms), id string(numeric), update_time number, amount number, address string (also the literal INTERNAL_DEPOSIT), status number (1 = arrived), txid string, source_address string, network_id null}`. Amount and fee are JSON numbers here, not strings.
- private/get-withdrawal-history (no params): `result.withdrawal_list[5]{currency, client_wid, fee number, create_time, id, update_time, amount number, address, status (5 = completed), txid, network_id string}`.
- private/get-trades (180-day window, limit 100): accepted with no window-size error; `result.data` was an empty array (no trade fills in 180 days on this account). Fill schema NOT verified live (rely on docs).
- private/get-order-history (180-day window): accepted, empty; schema not verified live.
- private/get-transactions (30-day window): accepted, empty; schema not verified live.
- Pagination/retention: deposit and withdrawal history returned 7 and 5 records with default params (docs: default 90 days, page/page_size, status filter); not probed further. Docs state 6-month retention for trade/order/transaction history.
- Balances live in the unified wallet; user-balance.position_balances is the per-asset view (4 non-zero positions here).

### Key permission introspection (Exchange)
No introspection endpoint. The heuristic probe `private/get-deposit-address` (param: currency) SUCCEEDED (code 0, returned 4 address records with fields currency, create_time, id, address, status, network enum(CRO|CRONOS|CRONOSZK|ETH)). Per the vendor docs ("Withdrawal setting must be enabled for your API Key") this indicates the Exchange key HAS withdrawal permission enabled; trade permission is not detectable. Returned addresses were not used or recorded.
Conclusion: the Exchange key does NOT appear read-only. inspectKey should return readOnly=false, or the owner should regenerate the key with "Can Read" only. Caveat: no negative control was available (no known read-only Exchange key), so lax server-side enforcement cannot be fully ruled out.

## Surprises / notes
- App key expires in 90 days and carries an `fiat.deposit:write` scope despite a presumably read-only intent.
- App transactions page size caps at 50; `limit` is silently ignored; `total` unreliable.
- Exchange deposit/withdrawal amounts are JSON numbers, not strings.
- The probe's generic enum printer echoed one PII field (holder name and country codes from get-accounts) to the probe console only; it is not in this file.
- Skipped: /v1/fiat/* deposit-info (sends email), anything write-like, private/user-balance-history, staking and fiat Exchange endpoints (not requested).
