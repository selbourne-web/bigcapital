import { createHash } from 'crypto';
import { computePayloadHash, serializePayload } from './payloadHash';

describe('computePayloadHash', () => {
  const payload = {
    id: 'T-1',
    price: '100.25',
    nested: { a: 1, b: ['x', null] },
  };

  it('equals the expression the sync engine used before the extraction', () => {
    const legacy = createHash('sha256')
      .update(JSON.stringify(payload))
      .digest('hex');
    expect(computePayloadHash(payload)).toBe(legacy);
  });

  it('is pinned to a literal digest so the output can never drift', () => {
    expect(computePayloadHash({ a: '1', b: ['x'] })).toBe(
      'e20e01af3d9c7bf4ada3832454ae9393c259a2dae012260ef957567ed5365c5a',
    );
  });

  it('serializes with plain JSON.stringify', () => {
    expect(serializePayload(payload)).toBe(JSON.stringify(payload));
  });
});
