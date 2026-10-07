import { createHmac } from 'crypto';
import { cryptoComSign, paramString } from './cryptocom.signing';

// Source: https://exchange-developer.crypto.com/exchange/v1/docs/api/rest-common-api-reference
// ("Digital Signature"): method private/get-order-detail, id 11, api_key "token",
// params {order_id: "53287421324"}, nonce 1587846358253, secret "secretKey". The docs page
// does not publish the final hex, so the expected value below was derived independently
// with node crypto HMAC-SHA256 over the concatenated payload string.
describe('cryptoComSign', () => {
  it('matches the docs worked example payload', () => {
    const payload =
      'private/get-order-detail11tokenorder_id532874213241587846358253';
    expect(
      cryptoComSign({
        method: 'private/get-order-detail',
        id: 11,
        apiKey: 'token',
        params: { order_id: '53287421324' },
        nonce: 1587846358253,
        secret: 'secretKey',
      }),
    ).toBe('02ef0a52c9428e5d3dcc5dd24d534ca39ef73f35acd3f6945f139a2364ef67a9');
    expect(
      createHmac('sha256', 'secretKey').update(payload).digest('hex'),
    ).toBe('02ef0a52c9428e5d3dcc5dd24d534ca39ef73f35acd3f6945f139a2364ef67a9');
  });

  it('handles empty params', () => {
    const sig = cryptoComSign({
      method: 'private/user-balance',
      id: 1,
      apiKey: 'K',
      params: {},
      nonce: 5,
      secret: 'S',
    });
    expect(sig).toBe(
      createHmac('sha256', 'S').update('private/user-balance1K5').digest('hex'),
    );
  });

  it('sorts keys and recurses into nested objects, arrays and nulls', () => {
    expect(
      paramString({ b: 1, a: { z: 'x', c: [1, 2, { q: null }] }, n: null }),
    ).toBe('a' + 'c' + '12' + 'q' + '' + 'zx' + 'b1' + 'n');
  });
});
