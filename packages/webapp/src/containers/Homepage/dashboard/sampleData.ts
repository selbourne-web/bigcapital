/**
 * Sample report responses for previewing the dashboard with populated charts.
 *
 * They mirror the real report JSON (same node ids, `horizontalTotals`,
 * `periods`, aging `total`), so the selectors and widgets take exactly the same
 * path as with live data. Deterministic per range, so the preview is stable.
 * Only used when the dashboard is opened with `?sample=1`, and always labelled.
 */
import moment from 'moment';
import type { DateRange, Granularity } from './ranges';

const UNIT: Record<Granularity, moment.unitOfTime.DurationConstructor> = {
  day: 'day',
  week: 'week',
  month: 'month',
  quarter: 'quarter',
};

/** Small deterministic PRNG (mulberry32) so charts don't change on every render. */
const seededRandom = (seedText: string) => {
  let seed = 0;
  for (let i = 0; i < seedText.length; i++) {
    seed = (Math.imul(31, seed) + seedText.charCodeAt(i)) | 0;
  }
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const buckets = ({ from, to }: DateRange, granularity: Granularity) => {
  const end = moment(to);
  const result: Array<{
    fromDate: { date: string };
    toDate: { date: string };
  }> = [];
  for (
    let cursor = moment(from);
    !cursor.isAfter(end) && result.length < 60;
    cursor = cursor.clone().add(1, UNIT[granularity])
  ) {
    const bucketEnd = moment.min(
      cursor.clone().add(1, UNIT[granularity]).subtract(1, 'day'),
      end,
    );
    result.push({
      fromDate: { date: cursor.format('YYYY-MM-DD') },
      toDate: { date: bucketEnd.format('YYYY-MM-DD') },
    });
  }
  return result;
};

const scaleFor = (granularity: Granularity) =>
  ({ day: 0.05, week: 0.25, month: 1, quarter: 3 })[granularity];

const amount = (value: number) => ({ amount: Math.round(value) });

export function sampleProfitLoss(
  range: DateRange,
  granularity: Granularity,
  empty = false,
) {
  const random = seededRandom(`pl-${range.from}-${range.to}-${granularity}`);
  const periods = buckets(range, granularity);
  const scale = empty ? 0 : scaleFor(granularity);

  const income = periods.map(
    (_, i) => 38000 * scale * (1 + i * 0.03) * (0.85 + random() * 0.3),
  );
  const cogs = income.map((v) => v * (0.16 + random() * 0.05));
  const expenseAccounts = [
    ['Payroll', 0.42],
    ['Rent', 0.16],
    ['Marketing', 0.11],
    ['Utilities', 0.07],
    ['Professional fees', 0.06],
    ['Insurance', 0.05],
    ['Travel', 0.04],
  ] as const;
  const expenses = periods.map(() => 24000 * scale * (0.9 + random() * 0.2));

  const withPeriods = (values: number[], sign = 1) =>
    periods.map((period, i) => ({
      ...period,
      total: amount(values[i] * sign),
    }));
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  const net = income.map((v, i) => v - cogs[i] - expenses[i]);

  return {
    query: {},
    data: [
      {
        id: 'INCOME',
        name: 'Income',
        nodeType: 'ACCOUNTS',
        total: amount(sum(income)),
        horizontalTotals: withPeriods(income),
        children: [],
      },
      {
        id: 'COST_OF_SALES',
        name: 'Cost of sales',
        nodeType: 'ACCOUNTS',
        total: amount(sum(cogs)),
        horizontalTotals: withPeriods(cogs),
        children: [
          {
            id: 1,
            name: 'Cost of goods sold',
            nodeType: 'ACCOUNT',
            total: amount(sum(cogs)),
          },
        ],
      },
      {
        id: 'EXPENSES',
        name: 'Expenses',
        nodeType: 'ACCOUNTS',
        // Real reports return expense totals as negative amounts.
        total: amount(-sum(expenses)),
        horizontalTotals: withPeriods(expenses, -1),
        children: expenseAccounts.map(([name, share], i) => ({
          id: 100 + i,
          name,
          nodeType: 'ACCOUNT',
          total: amount(-sum(expenses) * share),
        })),
      },
      {
        id: 'NET_INCOME',
        name: 'NET INCOME',
        nodeType: 'EQUATION',
        total: amount(sum(net)),
        horizontalTotals: withPeriods(net),
      },
    ],
  };
}

export function sampleCashFlow(
  range: DateRange,
  granularity: Granularity,
  empty = false,
) {
  const random = seededRandom(`cf-${range.from}-${range.to}-${granularity}`);
  const periods = buckets(range, granularity);
  const scale = empty ? 0 : scaleFor(granularity);

  let balance = empty ? 0 : 52000;
  const changes = periods.map(() => 9000 * scale * (random() * 1.6 - 0.35));
  const balances = changes.map((change) => (balance += change));

  return {
    data: [
      {
        id: 'NET_CASH_INCREASE',
        total: amount(changes.reduce((a, b) => a + b, 0)),
        periods: periods.map((period, i) => ({
          ...period,
          total: amount(changes[i]),
        })),
      },
      {
        id: 'CASH_END_PERIOD',
        total: amount(balances[balances.length - 1] ?? 0),
        periods: periods.map((period, i) => ({
          ...period,
          total: amount(balances[i]),
        })),
      },
    ],
  };
}

export function sampleAging(
  kind: 'receivable' | 'payable',
  asDate: string,
  empty = false,
) {
  const random = seededRandom(`aging-${kind}-${asDate}`);
  const base = empty ? 0 : kind === 'receivable' ? 46000 : 21000;
  const current = base * (0.45 + random() * 0.1);
  const columns = [
    { beforeDays: 0, toDays: 30, value: base * (0.22 + random() * 0.05) },
    { beforeDays: 31, toDays: 60, value: base * (0.12 + random() * 0.05) },
    { beforeDays: 61, toDays: null, value: base * (0.06 + random() * 0.05) },
  ];
  const total =
    current + columns.reduce((sum, column) => sum + column.value, 0);

  return {
    data: {
      total: {
        current: amount(current),
        aging: columns.map(({ value, ...column }) => ({
          ...column,
          total: amount(value),
        })),
        total: amount(total),
      },
    },
  };
}
