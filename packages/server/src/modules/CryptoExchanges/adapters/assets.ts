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

/** Canonical (upper-case, legacy-prefix-free) asset symbol for an exchange's raw symbol. */
export function normalizeAsset(
  exchange: CryptoExchangeId,
  raw: string,
): string {
  const upper = raw.trim().toUpperCase();
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

/** The assets the price feed should subscribe to: the held set plus earn underlyings. */
export function pricingAssets(assets: string[]): string[] {
  const out = new Set(assets);
  for (const asset of assets) {
    const underlying = earnUnderlying(asset);
    if (underlying) out.add(underlying);
  }
  return [...out].sort();
}
