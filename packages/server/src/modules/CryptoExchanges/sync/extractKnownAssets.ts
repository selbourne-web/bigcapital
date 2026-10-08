/** Largest asset set handed to an adapter as `knownAssets`. */
export const MAX_KNOWN_ASSETS = 500;
const MAX_DEPTH = 6;
const ASSET_KEYS = new Set(['asset', 'coin', 'commissionasset', 'feecoin']);
/** Pionex fill/order payloads carry `symbol` as BASE_QUOTE; only these markers qualify. */
const SYMBOL_SOURCES = new Set(['fills', 'order-history']);
const BASE_ASSET = /^[A-Z0-9]{2,20}$/;
const TICKER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/;

/**
 * Adds the asset symbols found in an exchange payload to `out`. Adapter-agnostic: it
 * only looks at the fields `asset`, `coin`, `commissionAsset` and `feeCoin` (any case) anywhere
 * in the object, upper-cases the value and keeps it when it looks like a ticker.
 * Bounded: nesting depth is capped, cycles are ignored and `out` never exceeds
 * MAX_KNOWN_ASSETS.
 */
export function extractAssetsFromPayload(
  payload: unknown,
  out: Set<string>,
): void {
  const seen = new WeakSet<object>();
  const walk = (node: unknown, depth: number) => {
    if (out.size >= MAX_KNOWN_ASSETS || depth > MAX_DEPTH) return;
    if (Array.isArray(node)) {
      if (seen.has(node)) return;
      seen.add(node);
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    // Pionex: base asset of `symbol` (BASE_QUOTE). Gated on the adapter's `_source`
    // marker so Binance (no underscore) and delivery symbols such as BTCUSDT_240628
    // elsewhere are never read.
    const rec = node as Record<string, unknown>;
    if (
      SYMBOL_SOURCES.has(rec._source as string) &&
      typeof rec.symbol === 'string' &&
      rec.symbol.includes('_')
    ) {
      const base = rec.symbol.split('_')[0].toUpperCase();
      if (BASE_ASSET.test(base) && out.size < MAX_KNOWN_ASSETS) out.add(base);
    }
    for (const [key, value] of Object.entries(node)) {
      if (ASSET_KEYS.has(key.toLowerCase())) {
        if (typeof value === 'string' && TICKER.test(value.trim())) {
          if (out.size < MAX_KNOWN_ASSETS) out.add(value.trim().toUpperCase());
        }
      } else {
        walk(value, depth + 1);
      }
    }
  };
  walk(payload, 0);
}
