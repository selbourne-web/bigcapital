import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { CryptoVault } from './CryptoVault.service';

const makeConfig = (keys: Record<number, string>, current = 1) =>
  ({
    get: (path: string) =>
      path === 'crypto'
        ? { encryptionKeys: keys, currentKeyVersion: current }
        : undefined,
  }) as unknown as ConfigService;

const key = () => randomBytes(32).toString('base64');

describe('CryptoVault', () => {
  it('round-trips a secret', () => {
    const vault = new CryptoVault(makeConfig({ 1: key() }));
    const { value, keyVersion } = vault.encrypt('api-secret-123');
    expect(keyVersion).toBe(1);
    expect(value).not.toContain('api-secret-123');
    expect(vault.decrypt(value, keyVersion)).toBe('api-secret-123');
  });

  it('produces different ciphertext for the same input', () => {
    const vault = new CryptoVault(makeConfig({ 1: key() }));
    expect(vault.encrypt('same').value).not.toBe(vault.encrypt('same').value);
  });

  it('throws when decrypting with an unknown key version', () => {
    const vault = new CryptoVault(makeConfig({ 1: key() }));
    const { value } = vault.encrypt('x');
    expect(() => vault.decrypt(value, 2)).toThrow();
  });

  it('throws on tampered ciphertext', () => {
    const vault = new CryptoVault(makeConfig({ 1: key() }));
    const { value } = vault.encrypt('x');
    const [iv, tag, ct] = value.split('.');
    const bad = Buffer.from(ct, 'base64');
    bad[0] ^= 1;
    expect(() =>
      vault.decrypt([iv, tag, bad.toString('base64')].join('.'), 1),
    ).toThrow();
  });

  it('fails fast when the key is empty', () => {
    expect(() => new CryptoVault(makeConfig({}))).toThrow(
      /CRYPTO_ENCRYPTION_KEY/,
    );
    expect(() => new CryptoVault(makeConfig({ 1: '' }))).toThrow(
      /CRYPTO_ENCRYPTION_KEY/,
    );
  });

  it('fails fast when the key is not 32 bytes', () => {
    const short = randomBytes(16).toString('base64');
    expect(() => new CryptoVault(makeConfig({ 1: short }))).toThrow(/32 bytes/);
  });
});
