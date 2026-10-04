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
