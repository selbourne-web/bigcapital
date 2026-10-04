const SECRET_KEY = /key|secret|passphrase|signature|token|authorization/i;

/** Deep copy of input with values of secret-like keys replaced. */
export function redactSecrets<T>(input: T): T {
  if (Array.isArray(input)) {
    return input.map((item) => redactSecrets(item)) as unknown as T;
  }
  if (input && typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
      out[k] = SECRET_KEY.test(k) ? '[REDACTED]' : redactSecrets(v);
    }
    return out as T;
  }
  return input;
}
