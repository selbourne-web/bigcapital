import { JwtService } from '@nestjs/jwt';
import { JWT_AUDIENCE, JWT_ISSUER } from '../Auth/Auth.constants';
import { CryptoLiveAuth, CryptoLiveAuthError } from './CryptoLiveAuth.service';

// Test-only secret; never a real one.
const SECRET = 'unit-test-secret-not-real-0123456789';
const signer = new JwtService({ secret: SECRET });

const sign = (
  sub: unknown = '7',
  opts: Record<string, unknown> = {},
  secret = SECRET,
) =>
  new JwtService({ secret }).sign(
    { sub },
    {
      algorithm: 'HS384',
      expiresIn: '1h',
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      ...opts,
    },
  );

/** Minimal fake of an Objection model: query().findOne(where) over rows. */
const model = (rows: Record<string, unknown>[]) =>
  ({
    query: () => ({
      findOne: async (where: Record<string, unknown>) =>
        rows.find((r) => Object.entries(where).every(([k, v]) => r[k] === v)),
    }),
  }) as any;

const build = (
  overrides: { users?: any[]; tenants?: any[]; memberships?: any[] } = {},
) => {
  const users = overrides.users ?? [{ id: 7 }, { id: 8 }];
  const tenants = overrides.tenants ?? [
    { id: 1, organizationId: 'org-a' },
    { id: 2, organizationId: 'org-b' },
  ];
  const memberships = overrides.memberships ?? [{ userId: 7, tenantId: 1 }];
  return new CryptoLiveAuth(
    { get: (k: string) => (k === 'jwt.secret' ? SECRET : undefined) } as any,
    model(users),
    model(tenants),
    model(memberships),
  );
};

const category = async (p: Promise<unknown>) => {
  const error = await p.then(
    () => undefined,
    (e) => e,
  );
  expect(error).toBeInstanceOf(CryptoLiveAuthError);
  return (error as CryptoLiveAuthError).category;
};

describe('CryptoLiveAuth.authenticate', () => {
  it('returns userId, tenantId and the token expiry (ms) for a member', async () => {
    const before = Date.now();
    const result = await build().authenticate(sign(), 'org-a');
    expect(result.userId).toBe(7);
    expect(result.tenantId).toBe(1);
    expect(result.organizationId).toBe('org-a');
    // exp is in whole seconds, 1h ahead
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + 3599_000);
    expect(result.expiresAt).toBeLessThanOrEqual(before + 3601_000);
  });

  it('refuses a valid token for an organization the user does NOT belong to', async () => {
    expect(await category(build().authenticate(sign(), 'org-b'))).toBe(
      'not-member',
    );
  });

  it('refuses an unknown organization', async () => {
    expect(await category(build().authenticate(sign(), 'org-zzz'))).toBe(
      'organization-not-found',
    );
  });

  it('refuses a user that no longer exists', async () => {
    expect(
      await category(build({ users: [] }).authenticate(sign(), 'org-a')),
    ).toBe('user-not-found');
  });

  it('refuses garbage, empty and tampered tokens', async () => {
    const auth = build();
    expect(await category(auth.authenticate('not-a-jwt', 'org-a'))).toBe(
      'invalid-token',
    );
    expect(await category(auth.authenticate('', 'org-a'))).toBe(
      'invalid-token',
    );
    const tampered = sign().slice(0, -3) + 'abc';
    expect(await category(auth.authenticate(tampered, 'org-a'))).toBe(
      'invalid-token',
    );
  });

  it('refuses a token signed with another secret', async () => {
    const forged = sign('7', {}, 'some-other-secret-value-0123456789');
    expect(await category(build().authenticate(forged, 'org-a'))).toBe(
      'invalid-token',
    );
  });

  it('refuses an expired token', async () => {
    const expired = sign('7', { expiresIn: '-10s' });
    expect(await category(build().authenticate(expired, 'org-a'))).toBe(
      'token-expired',
    );
  });

  it('refuses the wrong issuer, wrong audience and wrong algorithm', async () => {
    const auth = build();
    expect(
      await category(auth.authenticate(sign('7', { issuer: 'evil' }), 'org-a')),
    ).toBe('invalid-token');
    expect(
      await category(
        auth.authenticate(sign('7', { audience: 'other' }), 'org-a'),
      ),
    ).toBe('invalid-token');
    expect(
      await category(
        auth.authenticate(sign('7', { algorithm: 'HS256' }), 'org-a'),
      ),
    ).toBe('invalid-token');
  });

  it('refuses an unsigned (alg none) token', async () => {
    const b64 = (o: object) =>
      Buffer.from(JSON.stringify(o)).toString('base64url');
    const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
      sub: '7',
      iss: JWT_ISSUER,
      aud: JWT_AUDIENCE,
      exp: Math.floor(Date.now() / 1000) + 600,
    })}.`;
    expect(await category(build().authenticate(none, 'org-a'))).toBe(
      'invalid-token',
    );
  });

  it('refuses tokens without a numeric subject or without an expiry', async () => {
    const auth = build();
    expect(await category(auth.authenticate(sign('abc'), 'org-a'))).toBe(
      'invalid-token',
    );
    const noExp = signer.sign(
      { sub: '7' },
      { algorithm: 'HS384', issuer: JWT_ISSUER, audience: JWT_AUDIENCE },
    );
    expect(await category(auth.authenticate(noExp, 'org-a'))).toBe(
      'invalid-token',
    );
  });

  it('never leaks the token in the error message', async () => {
    const token = sign('abc');
    const error: Error = await build()
      .authenticate(token, 'org-a')
      .catch((e) => e);
    expect(String(error.message)).not.toContain(token);
    expect(JSON.stringify(error)).not.toContain(token);
  });

  it('fails construction when the JWT secret is not configured', () => {
    expect(
      () =>
        new CryptoLiveAuth({ get: () => undefined } as any, null, null, null),
    ).toThrow(/APP_JWT_SECRET/);
  });
});
