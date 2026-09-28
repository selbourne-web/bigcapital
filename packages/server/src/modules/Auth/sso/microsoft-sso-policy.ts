/** The claims this app actually reads from a Microsoft id_token. */
export interface MicrosoftIdTokenClaims {
  /** Tenant id ("tid"). */
  tid: string;
  /** Object id ("oid"): stable per user, per tenant. */
  oid: string;
  /** The account's email; Microsoft may send this as `email` or `preferred_username`. */
  email?: string;
  preferred_username?: string;
  name?: string;
  iss?: string;
  nonce?: string;
}

export interface MicrosoftSsoPolicy {
  allowedTenantIds: string[];
  allowedDomains: string[];
}

export type MicrosoftSsoRejection =
  | { allowed: false; reason: 'no_email' }
  | { allowed: false; reason: 'tenant_not_allowed' }
  | { allowed: false; reason: 'domain_not_allowed' };

export type MicrosoftSsoDecision =
  | { allowed: true; email: string }
  | MicrosoftSsoRejection;

/**
 * Decides whether a successfully-authenticated Microsoft account may sign in
 * here: an allow-listed tenant (when any are configured) AND always an
 * allow-listed email domain. Both checks are independent; either can reject.
 */
export function evaluateMicrosoftSsoPolicy(
  claims: MicrosoftIdTokenClaims,
  policy: MicrosoftSsoPolicy,
): MicrosoftSsoDecision {
  const email = (claims.email ?? claims.preferred_username ?? '').trim();
  if (!email || !email.includes('@')) {
    return { allowed: false, reason: 'no_email' };
  }
  if (
    policy.allowedTenantIds.length > 0 &&
    !policy.allowedTenantIds.includes(claims.tid)
  ) {
    return { allowed: false, reason: 'tenant_not_allowed' };
  }
  const domain = email.split('@')[1]?.toLowerCase();
  const allowedDomains = policy.allowedDomains.map((d) => d.toLowerCase());
  if (!domain || !allowedDomains.includes(domain)) {
    return { allowed: false, reason: 'domain_not_allowed' };
  }
  return { allowed: true, email: email.toLowerCase() };
}
