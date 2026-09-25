import moment from 'moment';

export type RangePreset =
  | 'this_month'
  | 'last_month'
  | 'last_30_days'
  | 'this_quarter'
  | 'last_quarter'
  | 'fiscal_ytd'
  | 'last_fiscal_year'
  | 'last_12_months'
  | 'custom';

/** Report bucket size for time-series widgets. */
export type Granularity = 'day' | 'week' | 'month' | 'quarter';

export interface DateRange {
  /** ISO dates (YYYY-MM-DD), inclusive. */
  from: string;
  to: string;
}

export interface RangeSelection {
  preset: RangePreset;
  /** Only used when `preset` is `custom`. */
  customFrom?: string;
  customTo?: string;
}

export const DEFAULT_RANGE: RangeSelection = { preset: 'fiscal_ytd' };

export const RANGE_PRESETS: Array<{ value: RangePreset; label: string }> = [
  { value: 'this_month', label: 'This month' },
  { value: 'last_month', label: 'Last month' },
  { value: 'last_30_days', label: 'Last 30 days' },
  { value: 'this_quarter', label: 'This quarter' },
  { value: 'last_quarter', label: 'Last quarter' },
  { value: 'fiscal_ytd', label: 'This fiscal year to date' },
  { value: 'last_fiscal_year', label: 'Last fiscal year' },
  { value: 'last_12_months', label: 'Last 12 months' },
  { value: 'custom', label: 'Custom range' },
];

const FISCAL_YEAR_KEYS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

const ISO = 'YYYY-MM-DD';

/** Start of the fiscal year containing `now`, given the org's start month. */
const fiscalYearStart = (now: moment.Moment, fiscalYearKey?: string) => {
  const monthIndex = Math.max(0, FISCAL_YEAR_KEYS.indexOf(fiscalYearKey ?? ''));
  const start = now.clone().month(monthIndex).startOf('month');
  return start.isAfter(now) ? start.subtract(1, 'year') : start;
};

/**
 * Resolves a selection to concrete dates. "This ..." presets run to today so
 * the charts describe what has actually happened.
 */
export function resolveRange(
  selection: RangeSelection,
  fiscalYearKey?: string,
  now: moment.Moment = moment(),
): DateRange {
  const today = now.clone().startOf('day');
  const range = (from: moment.Moment, to: moment.Moment): DateRange => ({
    from: from.format(ISO),
    to: to.format(ISO),
  });

  switch (selection.preset) {
    case 'this_month':
      return range(today.clone().startOf('month'), today);
    case 'last_month': {
      const start = today.clone().subtract(1, 'month').startOf('month');
      return range(start, start.clone().endOf('month'));
    }
    case 'last_30_days':
      return range(today.clone().subtract(29, 'days'), today);
    case 'this_quarter':
      return range(today.clone().startOf('quarter'), today);
    case 'last_quarter': {
      const start = today.clone().subtract(1, 'quarter').startOf('quarter');
      return range(start, start.clone().endOf('quarter'));
    }
    case 'last_fiscal_year': {
      const start = fiscalYearStart(today, fiscalYearKey).subtract(1, 'year');
      return range(start, start.clone().add(1, 'year').subtract(1, 'day'));
    }
    case 'last_12_months':
      return range(
        today.clone().subtract(11, 'months').startOf('month'),
        today,
      );
    case 'custom': {
      const from = moment(selection.customFrom, ISO, true);
      const to = moment(selection.customTo, ISO, true);
      if (from.isValid() && to.isValid() && !to.isBefore(from)) {
        return range(from, to);
      }
      return range(fiscalYearStart(today, fiscalYearKey), today);
    }
    case 'fiscal_ytd':
    default:
      return range(fiscalYearStart(today, fiscalYearKey), today);
  }
}

/** Picks a bucket size that yields a readable number of points. */
export function pickGranularity({ from, to }: DateRange): Granularity {
  const days = moment(to).diff(moment(from), 'days') + 1;
  if (days <= 14) return 'day';
  if (days <= 62) return 'week';
  if (days <= 400) return 'month';
  return 'quarter';
}

/** Short axis/tooltip label for the bucket starting at `date`. */
export function formatBucketLabel(
  date: string | Date,
  granularity: Granularity,
): string {
  const m = moment(date);
  switch (granularity) {
    case 'day':
    case 'week':
      return m.format('D MMM');
    case 'quarter':
      return `Q${m.quarter()} ${m.format('YYYY')}`;
    case 'month':
    default:
      return m.format('MMM YYYY');
  }
}

/** "1 Jan - 24 Sep 2026" style summary of a range. */
export function formatRangeLabel({ from, to }: DateRange): string {
  const start = moment(from);
  const end = moment(to);
  const sameYear = start.year() === end.year();
  return `${start.format(sameYear ? 'D MMM' : 'D MMM YYYY')} – ${end.format('D MMM YYYY')}`;
}
