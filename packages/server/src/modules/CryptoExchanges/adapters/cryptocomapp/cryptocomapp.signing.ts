import { createHmac } from 'crypto';

/**
 * Crypto.com App API signature (source-reviewed against the vendor client):
 * base64(HMAC-SHA256(secret, timestamp + METHOD + path + body)). `path` excludes the
 * query string; `body` is the raw request body, empty for GET.
 */
export const cryptoComAppSign = (a: {
  timestamp: number;
  method: string;
  path: string;
  body?: string;
  secret: string;
}): string =>
  createHmac('sha256', a.secret)
    .update(`${a.timestamp}${a.method.toUpperCase()}${a.path}${a.body ?? ''}`)
    .digest('base64');
