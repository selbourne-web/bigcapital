exports.up = (knex) => {
  return knex.schema.table('users', (table) => {
    // Microsoft Entra ID (SSO). `microsoft_oid` is the stable per-user,
    // per-tenant identifier Microsoft issues (the `oid` claim) - unique so
    // one Microsoft identity cannot be linked to two accounts.
    table.string('microsoft_oid').unique().nullable();
    table.string('sso_provider').nullable();

    // TOTP two-factor authentication (the fallback for non-SSO sign-in).
    // The secret is encrypted at rest (AES-256-GCM, MFA_ENCRYPTION_KEY).
    table.text('mfa_secret').nullable();
    table.boolean('mfa_enabled').notNullable().defaultTo(false);
    table.dateTime('mfa_enrolled_at').nullable();
    // JSON array of bcrypt hashes of one-time recovery codes.
    table.text('mfa_recovery_codes').nullable();
  });
};

exports.down = (knex) => {
  return knex.schema.table('users', (table) => {
    table.dropColumn('microsoft_oid');
    table.dropColumn('sso_provider');
    table.dropColumn('mfa_secret');
    table.dropColumn('mfa_enabled');
    table.dropColumn('mfa_enrolled_at');
    table.dropColumn('mfa_recovery_codes');
  });
};
