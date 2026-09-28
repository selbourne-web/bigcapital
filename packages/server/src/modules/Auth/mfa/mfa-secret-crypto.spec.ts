import { randomBytes } from 'crypto';
import { decryptSecret, encryptSecret } from './mfa-secret-crypto';

const key = randomBytes(32).toString('base64');

describe('mfa-secret-crypto', () => {
  it('round-trips a secret', () => {
    const encrypted = encryptSecret('JBSWY3DPEHPK3PXP', key);
    expect(decryptSecret(encrypted, key)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('never stores the plaintext secret in the encrypted value', () => {
    const encrypted = encryptSecret('JBSWY3DPEHPK3PXP', key);
    expect(encrypted).not.toContain('JBSWY3DPEHPK3PXP');
  });

  it('produces a different ciphertext each time (random IV)', () => {
    const a = encryptSecret('JBSWY3DPEHPK3PXP', key);
    const b = encryptSecret('JBSWY3DPEHPK3PXP', key);
    expect(a).not.toBe(b);
  });

  it('refuses to decrypt with the wrong key', () => {
    const encrypted = encryptSecret('JBSWY3DPEHPK3PXP', key);
    const wrongKey = randomBytes(32).toString('base64');
    expect(() => decryptSecret(encrypted, wrongKey)).toThrow();
  });

  it('refuses a tampered ciphertext (auth tag catches it)', () => {
    const encrypted = encryptSecret('JBSWY3DPEHPK3PXP', key);
    const [iv, tag, body] = encrypted.split('.');
    const tampered = [
      iv,
      tag,
      Buffer.from('nope').toString('base64') + body,
    ].join('.');
    expect(() => decryptSecret(tampered, key)).toThrow();
  });

  it('rejects a key that is not exactly 32 bytes', () => {
    const shortKey = Buffer.from('too-short').toString('base64');
    expect(() => encryptSecret('JBSWY3DPEHPK3PXP', shortKey)).toThrow();
  });
});
