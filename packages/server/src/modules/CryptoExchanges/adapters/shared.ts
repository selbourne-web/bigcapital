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

/** a - b on non-negative decimal strings, clamped at 0. */
export function subDecimal(a: string, b: string): string {
  const [ai, af = ''] = a.split('.');
  const [bi, bf = ''] = b.split('.');
  const scale = Math.max(af.length, bf.length);
  const x = BigInt(ai + af.padEnd(scale, '0'));
  const y = BigInt(bi + bf.padEnd(scale, '0'));
  return x > y ? formatDecimal(x - y, scale) : '0';
}

export const isZero = (v: string) => /^0*\.?0*$/.test(v);

export const isDecimal = (v: unknown): v is string =>
  typeof v === 'string' && /^\d+(\.\d+)?$/.test(v);

/** Fractional digits stored by the DECIMAL(36,18) balance columns. */
const STORED_SCALE = 18;

/**
 * Canonical form of a non-negative decimal string: no leading zeros, no trailing
 * fractional zeros, rounded half-up to the 18 places the balance columns store.
 * Exact (BigInt), never a float. Non-decimal input is returned trimmed unchanged.
 */
export function normalizeDecimal(
  value: string | number | null | undefined,
): string {
  const v = String(value ?? '').trim();
  if (!isDecimal(v)) return v;
  const [i, f = ''] = v.split('.');
  let scaled = BigInt(i + f.slice(0, STORED_SCALE).padEnd(STORED_SCALE, '0'));
  if (f.length > STORED_SCALE && f.charCodeAt(STORED_SCALE) >= 53) {
    scaled += BigInt(1);
  }
  return formatDecimal(scaled, STORED_SCALE);
}

/** Numeric equality of two decimal strings ('1.50' equals '1.5'). */
export const decimalEquals = (
  a: string | number | null | undefined,
  b: string | number | null | undefined,
): boolean => normalizeDecimal(a) === normalizeDecimal(b);

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
