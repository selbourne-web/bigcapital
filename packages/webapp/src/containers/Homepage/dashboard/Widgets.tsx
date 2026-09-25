import moment from 'moment';
import { useCallback, useMemo } from 'react';
import { WidgetCard } from './WidgetCard';
import { formatRangeLabel } from './ranges';
import type { DateRange } from './ranges';
import type {
  AgingSummary,
  CashFlowSummary,
  ProfitLossSummary,
} from './selectors';
import {
  AreaLineChart,
  DonutChart,
  GroupedBarChart,
  formatCompact,
  seriesColor,
} from '@/components/Charts';
import { useCurrentOrganizationBaseCurrency } from '@/hooks/query';
import { formattedAmount } from '@/utils';

/** What every widget needs from its `useQuery` result. */
interface QueryState<T> {
  data: T | undefined;
  isLoading: boolean;
  error: unknown;
  refetch: () => unknown;
}

interface WidgetProps<T> {
  query: QueryState<T>;
  range: DateRange;
}

/**
 * Formats amounts in the organization's base currency, like the rest of the app.
 * `full` keeps the currency's decimals (tooltips); `whole` drops them for
 * headline figures and legends, where cents are noise.
 */
function useMoney() {
  const currency = useCurrentOrganizationBaseCurrency() ?? '';
  const full = useCallback(
    (value: number) => formattedAmount(value, currency),
    [currency],
  );
  const whole = useCallback(
    (value: number) =>
      formattedAmount(Math.round(value), currency).replace(/\.0+$/, ''),
    [currency],
  );
  return { full, whole };
}

const INCOME_SERIES = { key: 'income', label: 'Income', color: seriesColor(0) };
const EXPENSE_SERIES = {
  key: 'expenses',
  label: 'Expenses',
  color: seriesColor(1),
};

function Legend({ items }: { items: Array<{ label: string; color: string }> }) {
  return (
    <ul className="dash-legend">
      {items.map((item) => (
        <li key={item.label} className="dash-legend__item">
          <span
            className="dash-legend__swatch"
            style={{ background: item.color }}
          />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

/** Big figure with a caption, in the brand display face. */
function Kpi({
  label,
  value,
  meta,
}: {
  label: string;
  value: string;
  meta?: string;
}) {
  return (
    <div className="dash-kpi">
      <span className="dash-kpi__label">{label}</span>
      <span className="dash-kpi__value">{value}</span>
      {meta && <span className="dash-kpi__meta">{meta}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------

export function ProfitLossWidget({
  query,
  range,
}: WidgetProps<ProfitLossSummary>) {
  const { full, whole } = useMoney();
  const summary = query.data;
  const { income = 0, expenses = 0, net = 0 } = summary?.totals ?? {};
  const largest = Math.max(income, expenses, 1);

  return (
    <WidgetCard
      title="Profit & loss"
      size="narrow"
      action={{
        label: 'View report',
        to: '/financial-reports/profit-loss-sheet',
      }}
      isLoading={query.isLoading}
      error={query.error}
      onRetry={query.refetch}
      isEmpty={income === 0 && expenses === 0}
      emptyText="No income or expenses recorded in this period."
      emptyAction={{ label: 'Create an invoice', to: '/invoices/new' }}
    >
      <Kpi
        label={net < 0 ? 'Net loss' : 'Net profit'}
        value={whole(net)}
        meta={formatRangeLabel(range)}
      />
      <ul className="dash-bars">
        {[
          { series: INCOME_SERIES, value: income },
          { series: EXPENSE_SERIES, value: expenses },
        ].map(({ series, value }) => (
          <li key={series.key} className="dash-bars__row">
            <span className="dash-bars__label">{series.label}</span>
            <span className="dash-bars__track" aria-hidden="true">
              <span
                className="dash-bars__fill"
                style={{
                  width: `${Math.max(2, (value / largest) * 100)}%`,
                  background: series.color,
                }}
              />
            </span>
            <span className="dash-bars__value">{whole(value)}</span>
          </li>
        ))}
      </ul>
    </WidgetCard>
  );
}

export function IncomeExpensesWidget({
  query,
  range,
}: WidgetProps<ProfitLossSummary>) {
  const { full, whole } = useMoney();
  const buckets = query.data?.buckets ?? [];
  const data = useMemo(
    () =>
      buckets.map((bucket) => ({
        label: bucket.label,
        income: bucket.income,
        expenses: bucket.expenses,
      })),
    [buckets],
  );
  const empty = buckets.every((b) => b.income === 0 && b.expenses === 0);

  return (
    <WidgetCard
      title="Income and expenses"
      size="wide"
      action={{
        label: 'View report',
        to: '/financial-reports/profit-loss-sheet',
      }}
      isLoading={query.isLoading}
      error={query.error}
      onRetry={query.refetch}
      isEmpty={empty}
      emptyText="No income or expenses recorded in this period."
      emptyAction={{ label: 'Create an invoice', to: '/invoices/new' }}
    >
      <Legend items={[INCOME_SERIES, EXPENSE_SERIES]} />
      <GroupedBarChart
        data={data}
        series={[INCOME_SERIES, EXPENSE_SERIES]}
        formatValue={full}
        formatAxis={formatCompact}
        height={210}
        ariaLabel={`Income and expenses by period, ${formatRangeLabel(range)}. Use the arrow keys to move between periods.`}
      />
    </WidgetCard>
  );
}

export function ExpensesWidget({
  query,
  range,
}: WidgetProps<ProfitLossSummary>) {
  const { full, whole } = useMoney();
  const summary = query.data;
  const slices = useMemo(
    () =>
      (summary?.expenseBreakdown ?? []).map((account, index) => ({
        key: `${account.name}-${index}`,
        label: account.name,
        value: account.value,
        color: seriesColor(index),
      })),
    [summary],
  );

  return (
    <WidgetCard
      title="Expenses"
      size="narrow"
      action={{
        label: 'View report',
        to: '/financial-reports/profit-loss-sheet',
      }}
      isLoading={query.isLoading}
      error={query.error}
      onRetry={query.refetch}
      isEmpty={slices.length === 0}
      emptyText="No expenses recorded in this period."
      emptyAction={{ label: 'Record an expense', to: '/expenses/new' }}
    >
      <DonutChart
        slices={slices}
        centerLabel="Total expenses"
        centerValue={whole(summary?.totals.expenses ?? 0)}
        formatValue={whole}
        ariaLabel={`Expenses by account, ${formatRangeLabel(range)}`}
      />
    </WidgetCard>
  );
}

export function CashFlowWidget({ query, range }: WidgetProps<CashFlowSummary>) {
  const { full, whole } = useMoney();
  const summary = query.data;
  const data = useMemo(
    () =>
      (summary?.points ?? []).map((point) => ({
        label: point.label,
        balance: point.balance,
      })),
    [summary],
  );
  const series = useMemo(
    () => [
      {
        key: 'balance',
        label: 'Cash balance',
        color: seriesColor(0),
        fill: true,
      },
    ],
    [],
  );
  const change = summary?.netChange ?? 0;

  return (
    <WidgetCard
      title="Cash flow"
      size="wide"
      action={{ label: 'View report', to: '/financial-reports/cash-flow' }}
      isLoading={query.isLoading}
      error={query.error}
      onRetry={query.refetch}
      isEmpty={data.length === 0 || data.every((p) => p.balance === 0)}
      emptyText="No cash movement recorded in this period."
      emptyAction={{ label: 'Record an expense', to: '/expenses/new' }}
    >
      <Kpi
        label="Cash at end of period"
        value={whole(summary?.endingBalance ?? 0)}
        meta={`${change >= 0 ? 'Up' : 'Down'} ${whole(Math.abs(change))} over the period`}
      />
      <AreaLineChart
        data={data}
        series={series}
        formatValue={full}
        formatAxis={formatCompact}
        height={200}
        ariaLabel={`Cash balance by period, ${formatRangeLabel(range)}. Use the arrow keys to move between periods.`}
      />
    </WidgetCard>
  );
}

/** Deeper red for older debt; "current" stays neutral. */
const AGING_COLORS = [
  seriesColor(1),
  seriesColor(4),
  seriesColor(2),
  seriesColor(0),
];

export function AgingWidget({
  query,
  kind,
  range,
}: {
  query: QueryState<AgingSummary>;
  kind: 'receivable' | 'payable';
  range: DateRange;
}) {
  const { full, whole } = useMoney();
  const summary = query.data;
  const isReceivable = kind === 'receivable';
  const slices = useMemo(
    () =>
      (summary?.buckets ?? []).map((bucket, index) => ({
        key: bucket.key,
        label: bucket.label,
        value: bucket.value,
        color: AGING_COLORS[index % AGING_COLORS.length],
      })),
    [summary],
  );

  return (
    <WidgetCard
      title={isReceivable ? 'Money owed to you' : 'Money you owe'}
      size="half"
      action={{
        label: 'View report',
        to: isReceivable
          ? '/financial-reports/receivable-aging-summary'
          : '/financial-reports/payable-aging-summary',
      }}
      isLoading={query.isLoading}
      error={query.error}
      onRetry={query.refetch}
      isEmpty={(summary?.total ?? 0) === 0}
      emptyText={
        isReceivable
          ? 'No unpaid invoices. Everything customers owe has been collected.'
          : 'No unpaid bills. You are all caught up with vendors.'
      }
      emptyAction={
        isReceivable
          ? { label: 'Create an invoice', to: '/invoices/new' }
          : { label: 'Add a bill', to: '/bills/new' }
      }
    >
      <Kpi
        label={isReceivable ? 'Total receivable' : 'Total payable'}
        value={whole(summary?.total ?? 0)}
        meta={`As of ${moment(range.to).format('D MMM YYYY')}`}
      />
      <DonutChart
        slices={slices}
        centerLabel="Overdue"
        centerValue={whole(summary?.overdue ?? 0)}
        formatValue={whole}
        ariaLabel={`${isReceivable ? 'Receivables' : 'Payables'} by age`}
        size={152}
      />
    </WidgetCard>
  );
}
