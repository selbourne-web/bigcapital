import { createHmac } from 'crypto';

/**
 * Pionex request signature: hex HMAC-SHA256(secret, PAYLOAD) where PAYLOAD is
 * `METHOD + PATH + "?" + sorted query "k=v" joined by "&"` (keys ascending, values
 * NOT URL-encoded, `timestamp` included) followed by the raw body for POST/DELETE.
 * https://pionex-doc.gitbook.io/apidocs/restful/general/authentication
 */
export function pionexPayload(a: {
  method: string;
  path: string;
  query: Record<string, string | number>;
  body?: string;
}): string {
  const qs = Object.keys(a.query)
    .sort()
    .map((k) => `${k}=${a.query[k]}`)
    .join('&');
  return `${a.method.toUpperCase()}${a.path}?${qs}${a.body ?? ''}`;
}

export function pionexSign(a: {
  method: string;
  path: string;
  query: Record<string, string | number>;
  body?: string;
  secret: string;
}): string {
  return createHmac('sha256', a.secret).update(pionexPayload(a)).digest('hex');
}
