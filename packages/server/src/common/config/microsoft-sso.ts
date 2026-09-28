import { castCommaListEnvVarToArray } from '@/utils/cast-comma-list-envvar-Array';
import { parseBoolean } from '@/utils/parse-boolean';
import { registerAs } from '@nestjs/config';

/** Only these email domains may sign in, whichever provider is used. */
const DEFAULT_ALLOWED_DOMAINS = ['selbourne.co', 'selbourneglobal.com'];

/**
 * "Sign in with Microsoft" (Entra ID / Microsoft 365) for the company's own
 * tenants. Off by default: the app registration must exist in Azure first.
 */
export default registerAs('microsoftSso', () => {
  const configuredDomains = castCommaListEnvVarToArray(
    process.env.MICROSOFT_SSO_ALLOWED_DOMAINS,
  ).map((domain) => domain.toLowerCase());

  return {
    enabled: parseBoolean<boolean>(process.env.MICROSOFT_SSO_ENABLED, false),
    clientId: process.env.MICROSOFT_SSO_CLIENT_ID || undefined,
    clientSecret: process.env.MICROSOFT_SSO_CLIENT_SECRET || undefined,
    // Empty = any Microsoft work/school account may attempt sign-in; the email
    // domain check below still applies regardless. Pinning the tenant id(s)
    // here is stronger, since it is checked before any domain is trusted.
    allowedTenantIds: castCommaListEnvVarToArray(
      process.env.MICROSOFT_SSO_ALLOWED_TENANT_IDS,
    ),
    allowedDomains: configuredDomains.length
      ? configuredDomains
      : DEFAULT_ALLOWED_DOMAINS,
    // Defaults to the webapp origin (BASE_URL), which already proxies /api in
    // dev and is the same origin as the API in production.
    redirectUri:
      process.env.MICROSOFT_SSO_REDIRECT_URI ||
      (process.env.BASE_URL
        ? `${process.env.BASE_URL.replace(/\/$/, '')}/api/auth/sso/microsoft/callback`
        : undefined),
  };
});
