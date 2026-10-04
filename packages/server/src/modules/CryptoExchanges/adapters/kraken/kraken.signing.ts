import { createHash, createHmac } from 'crypto';

/**
 * Kraken Spot REST signature:
 * base64(HMAC-SHA512(path + SHA256(nonce + body), base64decode(secret))).
 * `body` is the exact urlencoded POST body (it includes the nonce).
 * https://docs.kraken.com/api/docs/guides/spot-rest-auth
 */
export function signKraken(
  path: string,
  nonce: string,
  body: string,
  secretB64: string,
): string {
  const digest = createHash('sha256')
    .update(nonce + body)
    .digest();
  return createHmac('sha512', Buffer.from(secretB64, 'base64'))
    .update(Buffer.concat([Buffer.from(path, 'utf8'), digest]))
    .digest('base64');
}
