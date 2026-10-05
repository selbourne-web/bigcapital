/** Largest asset set handed to an adapter as `knownAssets`. */
export const MAX_KNOWN_ASSETS = 500;
const MAX_DEPTH = 6;
const ASSET_KEYS = new Set(['asset', 'coin', 'commissionasset']);
const TICKER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/;

/**
 * Adds the asset symbols found in an exchange payload to `out`. Adapter-agnostic: it
 * only looks at the fields `asset`, `coin` and `commissionAsset` (any case) anywhere
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
