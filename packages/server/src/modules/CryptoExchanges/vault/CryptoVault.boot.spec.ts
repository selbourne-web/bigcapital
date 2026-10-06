import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { randomBytes } from 'crypto';
import cryptoConfig from '@/common/config/crypto';
import { CryptoVault } from './CryptoVault.service';

/**
 * Boot check with the real config loader and real Nest DI: the vault is built
 * at application start, so a missing or malformed CRYPTO_ENCRYPTION_KEY must
 * make module compilation (the app boot) fail.
 */
describe('CryptoVault boot (real config + Nest DI)', () => {
  const saved = process.env.CRYPTO_ENCRYPTION_KEY;
  afterEach(() => {
    if (saved === undefined) delete process.env.CRYPTO_ENCRYPTION_KEY;
    else process.env.CRYPTO_ENCRYPTION_KEY = saved;
  });

  const boot = () =>
    Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          load: [cryptoConfig],
          ignoreEnvFile: true,
          isGlobal: true,
        }),
      ],
      providers: [CryptoVault],
    }).compile();

  it('refuses to boot without CRYPTO_ENCRYPTION_KEY', async () => {
    delete process.env.CRYPTO_ENCRYPTION_KEY;
    await expect(boot()).rejects.toThrow(/CRYPTO_ENCRYPTION_KEY is not set/);
  });

  it('refuses to boot with a wrong-length key', async () => {
    process.env.CRYPTO_ENCRYPTION_KEY = randomBytes(16).toString('base64');
    await expect(boot()).rejects.toThrow(/exactly 32 bytes/);
  });

  it('boots with a valid 32-byte key and round-trips a secret', async () => {
    process.env.CRYPTO_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    const moduleRef = await boot();
    const vault = moduleRef.get(CryptoVault);
    const { value, keyVersion } = vault.encrypt('fake-secret');
    expect(vault.decrypt(value, keyVersion)).toBe('fake-secret');
  });
});
