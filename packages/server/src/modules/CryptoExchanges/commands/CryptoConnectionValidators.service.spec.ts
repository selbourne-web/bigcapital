import { UnprocessableEntityException } from '@nestjs/common';
import { KeyHasExtraPermissionsError } from '../adapters/errors';
import {
  FAKE_KEY,
  FAKE_SECRET,
  FakeAccounts,
  FakeAdapter,
  FakeRepo,
  makeValidators,
} from './testFakes';

const input = { apiKey: FAKE_KEY, apiSecret: FAKE_SECRET };

describe('CryptoConnectionValidators.verifyCredentials (attestation)', () => {
  const setup = () => {
    const adapter = new FakeAdapter();
    const { validators } = makeValidators(
      adapter,
      new FakeAccounts(),
      new FakeRepo(),
    );
    return { adapter, validators };
  };

  it('throws 422 ATTESTATION_REQUIRED carrying the permissions and warnings', async () => {
    const { adapter, validators } = setup();
    adapter.inspection = {
      readOnly: 'unverifiable',
      permissions: ['fiat.deposit:write'],
      warnings: ['w1'],
    };

    const error = await validators
      .verifyCredentials('kraken', input)
      .catch((e) => e);

    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect(error.getStatus()).toBe(422);
    expect(error.getResponse()).toEqual({
      code: 'ATTESTATION_REQUIRED',
      permissions: ['fiat.deposit:write'],
      warnings: ['w1'],
    });
  });

  it('resolves when the user attests', async () => {
    const { adapter, validators } = setup();
    adapter.inspection = {
      readOnly: 'unverifiable',
      permissions: ['fiat.deposit:write'],
      warnings: ['w1'],
    };
    await expect(
      validators.verifyCredentials('kraken', input, true),
    ).resolves.toEqual({
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
      passphrase: undefined,
    });
  });

  it('refuses a key with extra permissions even when attested', async () => {
    const { adapter, validators } = setup();
    adapter.inspection = { readOnly: false, permissions: ['trade'] };
    await expect(
      validators.verifyCredentials('kraken', input, true),
    ).rejects.toBeInstanceOf(KeyHasExtraPermissionsError);
  });

  it('verifyCredentialsDetailed also returns the inspection (expiry, warnings)', async () => {
    const { adapter, validators } = setup();
    const expiresAt = new Date('2027-01-05T00:00:00Z');
    adapter.inspection = {
      readOnly: true,
      permissions: ['accounts:read'],
      expiresAt,
      warnings: ['n'],
    };
    const result = await validators.verifyCredentialsDetailed('kraken', input);
    expect(result.inspection).toEqual(adapter.inspection);
    expect(result.credentials.apiKey).toBe(FAKE_KEY);
  });

  it('defaults missing permissions/warnings to empty arrays in the 422 body', async () => {
    const { adapter, validators } = setup();
    adapter.inspection = { readOnly: 'unverifiable' } as any;
    const error = await validators
      .verifyCredentials('kraken', input)
      .catch((e) => e);
    expect(error.getResponse()).toEqual({
      code: 'ATTESTATION_REQUIRED',
      permissions: [],
      warnings: [],
    });
  });
});
