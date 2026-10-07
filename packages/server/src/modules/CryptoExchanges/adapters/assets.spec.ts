import { earnUnderlying, normalizeAsset, pricingAssets } from './assets';

describe('normalizeAsset', () => {
  it.each([
    ['XBT', 'BTC'],
    ['XXBT', 'BTC'],
    ['ZUSD', 'USD'],
    ['ZEUR', 'EUR'],
    ['XETH', 'ETH'],
    ['XXDG', 'DOGE'],
    ['USDT', 'USDT'],
    ['DOT', 'DOT'],
    ['DOT.S', 'DOT'],
    ['USD.M', 'USD'],
    ['XBT.M', 'BTC'],
    ['ETH.F', 'ETH'],
    ['ATOM.B', 'ATOM'],
    ['DOT.P', 'DOT'],
    [' xxbt ', 'BTC'],
  ])('kraken %s -> %s', (raw, expected) => {
    expect(normalizeAsset('kraken', raw)).toBe(expected);
  });

  it('only upper-cases and trims for other exchanges', () => {
    expect(normalizeAsset('binance', ' btc ')).toBe('BTC');
  });
});

describe('earnUnderlying / pricingAssets', () => {
  it.each([
    ['LDADA', 'ADA'],
    ['LDBTC', 'BTC'],
    ['LDUSDS', 'USDS'],
    ['LDFDUSD', 'FDUSD'],
    ['LDGAS', 'GAS'],
  ])('%s is an earn wrapper of %s', (asset, underlying) => {
    expect(earnUnderlying(asset)).toBe(underlying);
  });

  it.each([
    ['SOL.STAKED', 'SOL'],
    ['ETH.STAKED', 'ETH'],
    ['DOT.STAKED', 'DOT'],
    ['1INCH.STAKED', '1INCH'],
  ])('%s is a staked balance of %s (pricing only)', (asset, underlying) => {
    expect(earnUnderlying(asset)).toBe(underlying);
  });

  it.each([
    '.STAKED',
    'X.STAKED',
    'SOL.STAKED.STAKED',
    'sol.staked',
    'SOL.STAKE',
    'SOL.STAKED2',
    'SOL-STAKED',
    'A'.repeat(21) + '.STAKED',
  ])('%s is not a staked wrapper', (asset) => {
    expect(earnUnderlying(asset)).toBeUndefined();
  });

  it('pricingAssets adds the staked underlying next to the raw symbol', () => {
    expect(pricingAssets(['SOL.STAKED', 'CDCETH', 'SOL'])).toEqual([
      'CDCETH',
      'SOL',
      'SOL.STAKED',
    ]);
    expect(pricingAssets(['ETH.STAKED'])).toEqual(['ETH', 'ETH.STAKED']);
  });

  it.each(['LDO', 'LD', 'BTC', 'ADA', 'ldada', 'LDA.B', 'LD_ADA', 'CRCLX.T'])(
    '%s is not treated as an earn wrapper (LDO is the real Lido DAO token)',
    (asset) => {
      expect(earnUnderlying(asset)).toBeUndefined();
    },
  );

  it('adds underlyings next to the raw symbols, never replacing them, de-duplicated and sorted', () => {
    expect(pricingAssets(['LDADA', 'LDO', 'ADA', 'SOL', 'LDBTC'])).toEqual([
      'ADA',
      'BTC',
      'LDADA',
      'LDBTC',
      'LDO',
      'SOL',
    ]);
  });
});
