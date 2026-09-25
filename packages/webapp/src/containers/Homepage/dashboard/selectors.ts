/**
 * Turns report responses into the small shapes the dashboard widgets draw.
 *
 * The report endpoints return sheet-shaped JSON (trees of nodes with optional
 * per-period totals). These selectors are deliberately tolerant: a missing node
 * or period yields zeros and empty lists, never an exception, so a report the
 * user cannot see (or an empty organization) renders as an empty widget.
 */
import { formatBucketLabel } from './ranges';
import type { Granularity } from './ranges';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const num = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const asArray = (value: unknown): Json[] => (Array.isArray(value) ? value : []);

const findNode = (nodes: Json[], id: string): Json | undefined =>
  nodes.find((node) => node?.id === id);

const dateOf = (meta: Json): string | undefined =>
  meta?.date ?? meta?.formattedDate ?? undefined;

// ---------------------------------------------------------------------------
// Profit & loss
// ---------------------------------------------------------------------------

/** Nodes counted as money going out. Amounts may be signed, so we use magnitudes. */
const EXPENSE_NODE_IDS = ['COST_OF_SALES', 'EXPENSES', 'OTHER_EXPENSES'];
const MAX_EXPENSE_SLICES = 4;

export interface PeriodBucket {
  label: string;
  income: number;
  expenses: number;
  net: number;
}

export interface ProfitLossSummary {
  buckets: PeriodBucket[];
  totals: { income: number; expenses: number; net: number };
  /** Largest expense accounts first; the tail is folded into "Other". */
  expenseBreakdown: Array<{ name: string; value: number }>;
}

export function selectProfitLoss(
  response: Json,
  granularity: Granularity,
): ProfitLossSummary {
  const nodes = asArray(response?.data);
  const income = findNode(nodes, 'INCOME');
  const netIncome = findNode(nodes, 'NET_INCOME');
  const expenseNodes = EXPENSE_NODE_IDS.map((id) => findNode(nodes, id)).filter(
    Boolean,
  );

  // Period columns are identical on every node; INCOME is the reference.
  const periods = asArray(
    income?.horizontalTotals ?? netIncome?.horizontalTotals,
  );

  const buckets: PeriodBucket[] = periods.map((period, index) => {
    const incomeValue = num(income?.horizontalTotals?.[index]?.total?.amount);
    const expenseValue = expenseNodes.reduce(
      (sum, node) =>
        sum + Math.abs(num(node.horizontalTotals?.[index]?.total?.amount)),
      0,
    );
    const netValue = netIncome
      ? num(netIncome.horizontalTotals?.[index]?.total?.amount)
      : incomeValue - expenseValue;
    return {
      label: formatBucketLabel(dateOf(period?.fromDate) ?? '', granularity),
      income: incomeValue,
      expenses: expenseValue,
      net: netValue,
    };
  });

  const totalIncome = num(income?.total?.amount);
  const totalExpenses = expenseNodes.reduce(
    (sum, node) => sum + Math.abs(num(node.total?.amount)),
    0,
  );

  const accounts = expenseNodes
    .flatMap((node) => asArray(node.children))
    .map((child) => ({
      name: String(child?.name ?? ''),
      value: Math.abs(num(child?.total?.amount)),
    }))
    .filter((account) => account.value > 0)
    .sort((a, b) => b.value - a.value);

  const head = accounts.slice(0, MAX_EXPENSE_SLICES);
  const tail = accounts.slice(MAX_EXPENSE_SLICES);
  const otherValue = tail.reduce((sum, account) => sum + account.value, 0);

  return {
    buckets,
    totals: {
      income: totalIncome,
      expenses: totalExpenses,
      net: netIncome
        ? num(netIncome.total?.amount)
        : totalIncome - totalExpenses,
    },
    expenseBreakdown:
      otherValue > 0 ? [...head, { name: 'Other', value: otherValue }] : head,
  };
}

// ---------------------------------------------------------------------------
// Cash flow
// ---------------------------------------------------------------------------

export interface CashFlowSummary {
  points: Array<{ label: string; balance: number; change: number }>;
  endingBalance: number;
  netChange: number;
}

export function selectCashFlow(
  response: Json,
  granularity: Granularity,
): CashFlowSummary {
  const nodes = asArray(response?.data);
  const endNode = findNode(nodes, 'CASH_END_PERIOD');
  const changeNode = findNode(nodes, 'NET_CASH_INCREASE');

  const periods = asArray(endNode?.periods);
  const points = periods.map((period, index) => ({
    label: formatBucketLabel(dateOf(period?.fromDate) ?? '', granularity),
    balance: num(period?.total?.amount),
    change: num(changeNode?.periods?.[index]?.total?.amount),
  }));

  return {
    points,
    endingBalance: points.length
      ? points[points.length - 1].balance
      : num(endNode?.total?.amount),
    netChange: num(changeNode?.total?.amount),
  };
}

// ---------------------------------------------------------------------------
// Receivables / payables aging
// ---------------------------------------------------------------------------

export interface AgingBucket {
  key: string;
  label: string;
  value: number;
}

export interface AgingSummary {
  total: number;
  /** Not yet due. */
  current: number;
  /** Everything past due. */
  overdue: number;
  buckets: AgingBucket[];
}

const agingLabel = (beforeDays: number, toDays: number | null): string => {
  const start = Math.max(1, beforeDays);
  return toDays == null ? `${start}+ days` : `${start}–${toDays} days`;
};

export function selectAging(response: Json): AgingSummary {
  const total = response?.data?.total;
  const current = num(total?.current?.amount);
  const columns = asArray(total?.aging);

  const buckets: AgingBucket[] = [
    { key: 'current', label: 'Current', value: current },
    ...columns.map((column, index) => ({
      key: `aging-${index}`,
      label: agingLabel(
        num(column?.beforeDays),
        column?.toDays == null ? null : num(column.toDays),
      ),
      value: num(column?.total?.amount),
    })),
  ];

  const grand = num(total?.total?.amount);
  const sum = buckets.reduce((acc, bucket) => acc + bucket.value, 0);
  const overall = grand || sum;

  return {
    total: overall,
    current,
    overdue: Math.max(0, overall - current),
    buckets,
  };
}
