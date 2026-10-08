import { CryptoExchangeId } from '../CryptoExchanges.constants';

/** Kraken legacy 4-letter codes (X = crypto, Z = fiat prefix) and renames. */
const KRAKEN_ALIASES: Record<string, string> = {
  XBT: 'BTC',
  XXBT: 'BTC',
  XETH: 'ETH',
  XETC: 'ETC',
  XLTC: 'LTC',
  XXRP: 'XRP',
  XXLM: 'XLM',
  XXMR: 'XMR',
  XZEC: 'ZEC',
  XREP: 'REP',
  XMLN: 'MLN',
  XXDG: 'DOGE',
  ZUSD: 'USD',
  ZEUR: 'EUR',
  ZGBP: 'GBP',
  ZCAD: 'CAD',
  ZJPY: 'JPY',
  ZAUD: 'AUD',
  ZCHF: 'CHF',
};

/** Kraken staking / earn suffixes: .S staked, .M opt-in rewards, .F flex, .B bonded, .P parachain. */
export const KRAKEN_STAKING_SUFFIX = /\.(S|M|F|B|P)$/;

/**
 * Pionex symbol collisions. Our asset symbols are global, but Pionex's coin `METH` is
 * milli-ETH (1 mETH = 0.001 ETH, market METH_USDT), NOT Mantle Staked ETH which the
 * price feed knows as `METH` (~1000x more valuable). It is stored as the distinct
 * canonical asset `MILLIETH`; quantities are NOT rescaled (the unit stays milli-ETH, so
 * fills and balances stay consistent with Pionex's own market). Pricing looks through
 * via `UNIT_WRAPPERS`. Pionex market symbols (METH_USDT) are always the RAW symbols;
 * the adapter normalizes both sides when matching held coins to markets.
 */
const PIONEX_ALIASES: Record<string, string> = {
  METH: 'MILLIETH',
};

/** Canonical (upper-case, legacy-prefix-free) asset symbol for an exchange's raw symbol. */
export function normalizeAsset(
  exchange: CryptoExchangeId,
  raw: string,
): string {
  const upper = raw.trim().toUpperCase();
  if (exchange === 'pionex') {
    return PIONEX_ALIASES[upper] ?? upper;
  }
  if (exchange !== 'kraken') {
    return upper;
  }
  const base = upper.replace(KRAKEN_STAKING_SUFFIX, '');
  return KRAKEN_ALIASES[base] ?? base;
}

/**
 * Wrapper tokens that PRICING looks through: Binance Simple Earn `LD<X>` and
 * Crypto.com Exchange `<X>.STAKED`.
 *
 * Binance Simple Earn wrapper tokens are reported as `LD<X>` (LDADA, LDUSDS ...). Balances
 * and the ledger keep the raw symbol; only PRICING looks through to the underlying `X`.
 *
 * Rule (deliberately conservative): `LD` + an underlying of 3 to 17 `[A-Z0-9]`
 * characters. Requiring 3+ characters keeps real tokens such as LDO (Lido DAO,
 * underlying would be "O") from ever being treated as a wrapper. The raw symbol is
 * always kept as well and a consumer must prefer the raw symbol's own price when it has
 * one, so a legitimate `LD...` token that happens to match is never repriced by it.
 * Keep in sync with `earnUnderlying` in packages/webapp/src/containers/Crypto/valuation.ts.
 */
const EARN_WRAPPER = /^LD([A-Z0-9]{3,17})$/;

/**
 * Crypto.com Exchange staked balances are reported as `<X>.STAKED` (SOL.STAKED).
 * Same contract as `LD<X>`: pricing only, balances keep the raw symbol, and a raw
 * symbol's own quote wins. The dotted symbol itself is never subscribed to a price feed
 * (the feed symbol regexes are unchanged); only the underlying `X` is.
 */
const STAKED_WRAPPER = /^([A-Z0-9]{2,20})\.STAKED$/;

export function earnUnderlying(asset: string): string | undefined {
  return EARN_WRAPPER.exec(asset)?.[1] ?? STAKED_WRAPPER.exec(asset)?.[1];
}

/**
 * Assets quoted in a fraction of another asset's unit (`price = underlying x factor`).
 * Keep in sync with `UNIT_WRAPPERS` in packages/webapp/src/containers/Crypto/valuation.ts.
 */
const UNIT_WRAPPERS: Record<string, { underlying: string; factor: number }> = {
  MILLIETH: { underlying: 'ETH', factor: 0.001 },
};

export function unitWrapper(
  asset: string,
): { underlying: string; factor: number } | undefined {
  return Object.prototype.hasOwnProperty.call(UNIT_WRAPPERS, asset)
    ? UNIT_WRAPPERS[asset]
    : undefined;
}

/** The assets the price feed should subscribe to: the held set plus earn/unit underlyings. */
export function pricingAssets(assets: string[]): string[] {
  const out = new Set(assets);
  for (const asset of assets) {
    const underlying = earnUnderlying(asset) ?? unitWrapper(asset)?.underlying;
    if (underlying) out.add(underlying);
  }
  return [...out].sort();
}
