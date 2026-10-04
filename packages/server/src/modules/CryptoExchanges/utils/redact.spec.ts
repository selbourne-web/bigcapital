import { redactSecrets } from './redact';

describe('redactSecrets', () => {
  it('redacts secret-like keys at any depth and leaves others alone', () => {
    const input = {
      exchange: 'binance',
      nested: { apiSecret: 's', Authorization: 'Bearer x', keep: 1 },
      list: [{ passphrase: 'p', label: 'main' }],
    };
    expect(redactSecrets(input)).toEqual({
      exchange: 'binance',
      nested: { apiSecret: '[REDACTED]', Authorization: '[REDACTED]', keep: 1 },
      list: [{ passphrase: '[REDACTED]', label: 'main' }],
    });
  });

  it('does not mutate the input', () => {
    const input = { nested: { apiSecret: 's' } };
    const out = redactSecrets(input);
    expect(input.nested.apiSecret).toBe('s');
    expect(out).not.toBe(input);
  });

  it('passes primitives and null through', () => {
    expect(redactSecrets(null)).toBeNull();
    expect(redactSecrets('text')).toBe('text');
  });
});
