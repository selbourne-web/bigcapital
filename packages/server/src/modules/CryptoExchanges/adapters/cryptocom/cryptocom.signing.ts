import { createHmac } from 'crypto';

/**
 * Crypto.com Exchange parameter string: keys in ascending order, each key followed
 * by its value, recursing into objects and arrays with no separators. null/undefined
 * become the empty string (per the official docs).
 * https://exchange-developer.crypto.com/exchange/v1/docs/api/rest-common-api-reference
 */
export function paramString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(paramString).join('');
  if (typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => k + paramString((value as Record<string, unknown>)[k]))
      .join('');
  }
  return String(value);
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
