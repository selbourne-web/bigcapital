/**
 * Chart theme tokens.
 *
 * Follows the bklit-ui conventions (theme through `--chart-*` variables, never
 * one-off colours): the variables live in `_variables.scss` for the light and
 * dark themes, and charts only ever reference them through `chartCssVars`.
 */
export const chartCssVars = {
  /** Series palette, `--chart-1` ... `--chart-5`. */
  series: [
    'var(--chart-1)',
    'var(--chart-2)',
    'var(--chart-3)',
    'var(--chart-4)',
    'var(--chart-5)',
  ],
  grid: 'var(--chart-grid)',
  axisText: 'var(--chart-axis-text)',
  crosshair: 'var(--chart-crosshair)',
  track: 'var(--chart-track)',
} as const;

/** Colour for the n-th series, wrapping around the palette. */
export const seriesColor = (index: number): string =>
  chartCssVars.series[index % chartCssVars.series.length];

/** Duration of the one-off enter animation, in milliseconds. */
export const CHART_REVEAL_MS = 1100;
