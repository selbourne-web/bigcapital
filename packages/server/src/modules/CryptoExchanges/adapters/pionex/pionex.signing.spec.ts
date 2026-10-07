import { createHmac } from 'crypto';
import { pionexPayload, pionexSign } from './pionex.signing';

const VENDOR_SECRET = 'NFqv4MB3hB0SOiEsJNDP9e0jDdKPWbDqS_Z1dbU4';
const VENDOR_STRING =
  'GET/api/v1/trade/allOrders?limit=1&symbol=BTC_USDT&timestamp=1655896754515';

describe('pionexSign', () => {
  // Vendor inputs from https://pionex-doc.gitbook.io/apidocs/restful/general/authentication.
  // The page prints the signature ec83d21e1237cbe7e0172f79c0e3a4741c86f6b201ba762f21149bf195519be1,
  // which does NOT reproduce (checked against many payload variants). Live signing was
  // verified against the real API on 2026-10-07 (the key authenticated on every call), so
  // the doc's printed value is inconsistent and the expected value below was derived
  // independently with node crypto HMAC-SHA256 over the documented string-to-sign.
  it('matches the independently derived value for the vendor inputs', () => {
    const expected =
      '25dbbd2a6478ec4870653249d644cfb246eee4da347645cc98373f275e189242';
    expect(
      pionexSign({
        method: 'GET',
        path: '/api/v1/trade/allOrders',
        // deliberately unsorted: the function must sort
        query: { timestamp: 1655896754515, symbol: 'BTC_USDT', limit: 1 },
        secret: VENDOR_SECRET,
      }),
    ).toBe(expected);
    expect(
      createHmac('sha256', VENDOR_SECRET).update(VENDOR_STRING).digest('hex'),
    ).toBe(expected);
  });

  it('builds the payload sorted, not URL-encoded, with method and path prepended', () => {
    expect(
      pionexPayload({
        method: 'get',
        path: '/api/v1/x',
        query: { z: 'a b', timestamp: 5, a: 'x/y&z' },
      }),
    ).toBe('GET/api/v1/x?a=x/y&z&timestamp=5&z=a b');
  });

  it('appends the raw body for POST/DELETE (never sent by the adapter)', () => {
    const body = '{"a":1}';
    expect(
      pionexPayload({
        method: 'POST',
        path: '/api/v1/p',
        query: { timestamp: 7 },
        body,
      }),
    ).toBe('POST/api/v1/p?timestamp=7{"a":1}');
    expect(
      pionexSign({
        method: 'POST',
        path: '/api/v1/p',
        query: { timestamp: 7 },
        body,
        secret: 'S',
      }),
    ).toBe(
      createHmac('sha256', 'S')
        .update('POST/api/v1/p?timestamp=7{"a":1}')
        .digest('hex'),
    );
  });

  it('second synthetic vector: timestamp-only GET', () => {
    expect(
      pionexSign({
        method: 'GET',
        path: '/api/v1/account/balances',
        query: { timestamp: 1700000000000 },
        secret: 'S',
      }),
    ).toBe(
      createHmac('sha256', 'S')
        .update('GET/api/v1/account/balances?timestamp=1700000000000')
        .digest('hex'),
    );
  });
});
