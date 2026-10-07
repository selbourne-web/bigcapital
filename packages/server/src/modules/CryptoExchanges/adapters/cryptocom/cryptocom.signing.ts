import { createHmac } from 'crypto';

/**
 * Crypto.com Exchange parameter string: keys in ascending order, each key followed
 * by its value, recursing into objects and arrays with no separators.
 * A top-level null/undefined param value becomes the empty string (the docs JS
 * sample). Nested nulls are NOT specified consistently in the docs: the Python/Java
 * samples concatenate "null", which this follows. This adapter only ever sends flat
 * params, so nested behaviour is not exercised in production.
 * https://exchange-developer.crypto.com/exchange/v1/docs/api/rest-common-api-reference
 */
function nested(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return value.map(nested).join('');
  if (typeof value === 'object')
    return sorted(value as Record<string, unknown>, nested);
  return String(value);
}

function sorted(
  obj: Record<string, unknown>,
  inner: (v: unknown) => string,
): string {
  return Object.keys(obj)
    .sort()
    .map((k) => k + inner(obj[k]))
    .join('');
}

export function paramString(params: Record<string, unknown>): string {
  return sorted(params, (v) =>
    v === null || v === undefined ? '' : nested(v),
  );
}

/** Lower-case hex HMAC-SHA256 of method + id + apiKey + paramString(params) + nonce. */
export const cryptoComSign = (a: {
  method: string;
  id: number;
  apiKey: string;
  params: Record<string, unknown>;
  nonce: number;
  secret: string;
}): string =>
  createHmac('sha256', a.secret)
    .update(`${a.method}${a.id}${a.apiKey}${paramString(a.params)}${a.nonce}`)
    .digest('hex');
