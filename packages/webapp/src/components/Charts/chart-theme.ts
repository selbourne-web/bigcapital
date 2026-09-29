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

/**
 * Semantic dashboard colours, deliberately outside the brand-monochrome
 * `chartCssVars.series` palette: income/expenses/receivable/payable read at
 * a glance faster when they match the universal green/red/blue/orange
 * convention instead of shades of maroon.
 */
export const semanticChartColors = {
  income: 'var(--chart-income)',
  expense: 'var(--chart-expense)',
  receivable: 'var(--chart-receivable)',
  payable: 'var(--chart-payable)',
} as const;

/** Shades from least to most overdue, for the receivable aging donut. */
export const receivableAgingColors = [
  'var(--color-blue-100)',
  'var(--color-blue-200)',
  'var(--color-blue-300)',
  'var(--color-blue-400)',
  'var(--color-blue-500)',
] as const;

/** Shades from least to most overdue, for the payable aging donut. */
export const payableAgingColors = [
  'var(--color-orange-100)',
  'var(--color-orange-200)',
  'var(--color-orange-300)',
  'var(--color-orange-400)',
  'var(--color-orange-500)',
] as const;

/** Shades for the expense-breakdown-by-category donut. */
export const expenseShades = [
  'var(--color-red-100)',
  'var(--color-red-200)',
  'var(--color-red-300)',
  'var(--color-red-400)',
  'var(--color-red-500)',
] as const;

/** Cash flow line/area colour by sign relative to the zero baseline. */
export const cashflowColors = {
  up: 'var(--chart-cashflow-up)',
  zero: 'var(--chart-cashflow-zero)',
  down: 'var(--chart-cashflow-down)',
} as const;

/** Duration of the one-off enter animation, in milliseconds. */
export const CHART_REVEAL_MS = 1100;
