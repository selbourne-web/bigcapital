import { normalizeAsset } from './assets';

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
