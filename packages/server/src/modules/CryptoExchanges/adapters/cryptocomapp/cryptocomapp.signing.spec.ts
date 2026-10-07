import { createHmac } from 'crypto';
import { cryptoComAppSign } from './cryptocomapp.signing';

describe('cryptoComAppSign', () => {
  // Inputs: timestamp 1700000000000, GET /v1/api-keys/current, empty body, secret
  // "TEST_SECRET". Expected value derived independently with node crypto over the
  // concatenated payload "1700000000000GET/v1/api-keys/current".
  it('matches an independently computed vector', () => {
    const expected = createHmac('sha256', 'TEST_SECRET')
      .update('1700000000000GET/v1/api-keys/current')
      .digest('base64');
    const sig = cryptoComAppSign({
      timestamp: 1700000000000,
      method: 'get',
      path: '/v1/api-keys/current',
      secret: 'TEST_SECRET',
    });
    expect(sig).toBe(expected);
    expect(sig).toBe('G2JC6rIw7hq+o2o/TcC6qHPpvFjZJh75H7ir3wFwNWE=');
  });

  it('includes the body and upper-cases the method', () => {
    expect(
      cryptoComAppSign({
        timestamp: 5,
        method: 'post',
        path: '/p',
        body: '{"a":1}',
        secret: 'S',
      }),
    ).toBe(createHmac('sha256', 'S').update('5POST/p{"a":1}').digest('base64'));
  });
});
