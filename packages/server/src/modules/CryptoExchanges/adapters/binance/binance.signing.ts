import { createHmac } from 'crypto';

/**
 * Binance SIGNED endpoint signature: hex(HMAC-SHA256(queryString, secret)).
 * `queryString` is the exact urlencoded query (or body) that will be sent,
 * including `timestamp` (and `recvWindow`), without the `signature` parameter.
 * https://developers.binance.com/docs/binance-spot-api-docs/rest-api/request-security
 */
export function signBinance(queryString: string, secret: string): string {
  return createHmac('sha256', secret).update(queryString).digest('hex');
}
