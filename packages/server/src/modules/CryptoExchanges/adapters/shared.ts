/** Generic helpers shared by exchange adapters. */

/** Add non-negative decimal strings exactly (no float rounding). */
export function addDecimal(a: string, b: string): string {
  const [ai, af = ''] = a.split('.');
  const [bi, bf = ''] = b.split('.');
  const scale = Math.max(af.length, bf.length);
  const total =
    BigInt(ai + af.padEnd(scale, '0')) + BigInt(bi + bf.padEnd(scale, '0'));
  return formatDecimal(total, scale);
}

function formatDecimal(scaled: bigint, scale: number): string {
  const digits = scaled.toString().padStart(scale + 1, '0');
  const int = digits.slice(0, digits.length - scale);
  const frac = digits.slice(digits.length - scale).replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int;
}

export const isZero = (v: string) => /^0*\.?0*$/.test(v);

export const isDecimal = (v: unknown): v is string =>
  typeof v === 'string' && /^\d+(\.\d+)?$/.test(v);

export const MAX_ERROR_TEXT = 300;

/** Strip secrets from text and bound its length. */
export function sanitizeText(
  text: unknown,
  secrets: (string | undefined)[],
): string {
  let out = typeof text === 'string' ? text : '';
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('[REDACTED]');
  }
  return out.length > MAX_ERROR_TEXT
    ? `${out.slice(0, MAX_ERROR_TEXT)}...`
    : out;
}
