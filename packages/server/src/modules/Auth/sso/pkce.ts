import { createHash, randomBytes } from 'crypto';

const base64url = (buffer: Buffer): string =>
  buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

/** A random, URL-safe string (`state`, `nonce`, PKCE `code_verifier`). */
export const randomUrlSafeToken = (bytes = 32): string =>
  base64url(randomBytes(bytes));

/** The S256 PKCE code challenge for a given code verifier. */
export const pkceCodeChallenge = (codeVerifier: string): string =>
  base64url(createHash('sha256').update(codeVerifier).digest());
