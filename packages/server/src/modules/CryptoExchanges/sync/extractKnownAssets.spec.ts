import {
  extractAssetsFromPayload,
  MAX_KNOWN_ASSETS,
} from './extractKnownAssets';

describe('extractAssetsFromPayload', () => {
  it('reads asset / coin / commissionAsset fields case-insensitively and upper-cases them', () => {
    const out = new Set<string>();
    extractAssetsFromPayload(
      { asset: 'eth', coin: 'Sol', commissionAsset: 'bnb' },
      out,
    );
    expect([...out].sort()).toEqual(['BNB', 'ETH', 'SOL']);
  });

  it('walks nested objects and arrays but ignores other fields', () => {
    const out = new Set<string>();
    extractAssetsFromPayload(
      {
        symbol: 'ETHBTC',
        fills: [{ commissionAsset: 'BNB' }],
        meta: { deep: { asset: 'ADA' } },
      },
      out,
    );
    expect([...out].sort()).toEqual(['ADA', 'BNB']);
  });

  it('ignores non-string values, empty strings and values that are not ticker-shaped', () => {
    const out = new Set<string>();
    extractAssetsFromPayload(
      {
        asset: 12,
        coin: '',
        commissionAsset: 'not a ticker!!',
        other: { asset: null },
      },
      out,
    );
    expect(out.size).toBe(0);
  });

  it('is bounded: stops at the depth limit and survives circular references', () => {
    const out = new Set<string>();
    const circular: any = { asset: 'BTC' };
    circular.self = circular;
    extractAssetsFromPayload(circular, out);
    let deep: any = { asset: 'TOODEEP' };
    for (let i = 0; i < 20; i++) deep = { child: deep };
    extractAssetsFromPayload(deep, out);
    expect([...out]).toEqual(['BTC']);
  });

  it('never grows the set past the cap', () => {
    const out = new Set<string>();
    for (let i = 0; i < MAX_KNOWN_ASSETS + 50; i++) {
      extractAssetsFromPayload({ asset: `A${i}` }, out);
    }
    expect(out.size).toBe(MAX_KNOWN_ASSETS);
  });
});
