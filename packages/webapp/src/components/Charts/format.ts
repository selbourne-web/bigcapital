/**
 * Compact axis labels: 1.2K, 3.4M. Currency symbols are left to the tooltip and
 * KPI values, where the app's own money formatter is used.
 */
const compactFormatter = new Intl.NumberFormat('en', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

export const formatCompact = (value: number): string =>
  compactFormatter.format(value);

/** Percentage with no decimals below 10% precision, one above. */
export const formatPercent = (ratio: number): string => {
  if (!Number.isFinite(ratio)) return '0%';
  const pct = ratio * 100;
  return `${pct >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10}%`;
};

/**
 * Whether the tick at `index` gets a label. Labels every `every`-th point and
 * always the last one, dropping a regular tick that would sit right next to it.
 */
export const showTickLabel = (
  index: number,
  count: number,
  every: number,
): boolean =>
  index === count - 1 ||
  (index % every === 0 && count - 1 - index >= Math.ceil(every * 0.75));

/** Every n-th index to label so ticks never overlap (always keeps first/last). */
export const tickEvery = (count: number, width: number, minGap = 64): number =>
  Math.max(1, Math.ceil(count / Math.max(1, Math.floor(width / minGap))));
