/** Value helpers for Nexo exports. Pure; no logging of cell values. */

const NEXO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const EPOCH_MS_RE = /^\d{13}$/;
const EPOCH_MIN_MS = Date.UTC(2015, 0, 1);
const EPOCH_MAX_MS = Date.UTC(2100, 0, 1);

/** Strict `YYYY-MM-DD HH:MM:SS`, a real calendar instant, read as UTC. */
export function parseNexoUtc(text: string): Date | null {
  if (typeof text !== 'string') return null;
  const m = NEXO_DATE_RE.exec(text);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== mo - 1 ||
    date.getUTCDate() !== d ||
    date.getUTCHours() !== h ||
    date.getUTCMinutes() !== mi ||
    date.getUTCSeconds() !== s
  ) {
    return null;
  }
  return date;
}

/** 13-digit epoch milliseconds between 2015-01-01 and 2100-01-01. */
export function parseEpochMs(text: string): Date | null {
  if (typeof text !== 'string' || !EPOCH_MS_RE.test(text)) return null;
  const ms = Number(text);
  return ms >= EPOCH_MIN_MS && ms <= EPOCH_MAX_MS ? new Date(ms) : null;
}

/** Trimmed cell, or null for the blank tokens `''`, `-` and `null` (any case). */
export function nexoCell(text: string | undefined): string | null {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (t === '' || t === '-' || t.toLowerCase() === 'null') return null;
  return t;
}

/**
 * Plain signed decimal, at most 20 fractional digits (the futures export
 * carries float noise of up to 16), no exponent or separators. Values are
 * stored as raw text and never calculated with, so the cap only rejects garbage.
 */
export const isNexoDecimal = (text: string): boolean =>
  typeof text === 'string' && /^-?\d+(\.\d{1,20})?$/.test(text);

/** `$` followed by a non-negative plain decimal. */
export const isNexoUsd = (text: string): boolean =>
  typeof text === 'string' && /^\$\d+(\.\d+)?$/.test(text);
