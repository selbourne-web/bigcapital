import { evaluateMicrosoftSsoPolicy } from './microsoft-sso-policy';

const claims = (over: Record<string, unknown> = {}) => ({
  tid: 'tenant-1',
  oid: 'user-object-id',
  preferred_username: 'scott.griffith@selbourne.co',
  ...over,
});

const policy = (over: Record<string, unknown> = {}) => ({
  allowedTenantIds: [],
  allowedDomains: ['selbourne.co', 'selbourneglobal.com'],
  ...over,
});

describe('evaluateMicrosoftSsoPolicy', () => {
  it('allows an account on an allowed domain, no tenant restriction set', () => {
    const result = evaluateMicrosoftSsoPolicy(claims(), policy());
    expect(result).toEqual({
      allowed: true,
      email: 'scott.griffith@selbourne.co',
    });
  });

  it('allows the other configured company domain', () => {
    const result = evaluateMicrosoftSsoPolicy(
      claims({ preferred_username: 'someone@selbourneglobal.com' }),
      policy(),
    );
    expect(result.allowed).toBe(true);
  });

  it('rejects an outside domain even with a valid Microsoft token', () => {
    const result = evaluateMicrosoftSsoPolicy(
      claims({ preferred_username: 'attacker@gmail.com' }),
      policy(),
    );
    expect(result).toEqual({ allowed: false, reason: 'domain_not_allowed' });
  });

  it('is case-insensitive on the domain', () => {
    const result = evaluateMicrosoftSsoPolicy(
      claims({ preferred_username: 'Scott@Selbourne.CO' }),
      policy(),
    );
    expect(result.allowed).toBe(true);
  });

  it('prefers the "email" claim over "preferred_username" when both are present', () => {
    const result = evaluateMicrosoftSsoPolicy(
      claims({
        email: 'scott.griffith@selbourne.co',
        preferred_username: 'not-an-email-upn',
      }),
      policy(),
    );
    expect(result).toEqual({
      allowed: true,
      email: 'scott.griffith@selbourne.co',
    });
  });

  it('rejects when there is no usable email claim at all', () => {
    const result = evaluateMicrosoftSsoPolicy(
      claims({ preferred_username: undefined }),
      policy(),
    );
    expect(result).toEqual({ allowed: false, reason: 'no_email' });
  });

  it('rejects a tenant not on the allow-list, even on an allowed domain', () => {
    const result = evaluateMicrosoftSsoPolicy(
      claims({ tid: 'some-other-tenant' }),
      policy({ allowedTenantIds: ['tenant-1', 'tenant-2'] }),
    );
    expect(result).toEqual({ allowed: false, reason: 'tenant_not_allowed' });
  });

  it('allows a listed tenant on an allowed domain', () => {
    const result = evaluateMicrosoftSsoPolicy(
      claims({ tid: 'tenant-2' }),
      policy({ allowedTenantIds: ['tenant-1', 'tenant-2'] }),
    );
    expect(result.allowed).toBe(true);
  });

  it('checks the tenant before the domain, so a spoofed domain on the wrong tenant still fails', () => {
    const result = evaluateMicrosoftSsoPolicy(
      claims({ tid: 'wrong-tenant', preferred_username: 'x@selbourne.co' }),
      policy({ allowedTenantIds: ['tenant-1'] }),
    );
    expect(result).toEqual({ allowed: false, reason: 'tenant_not_allowed' });
  });
});
