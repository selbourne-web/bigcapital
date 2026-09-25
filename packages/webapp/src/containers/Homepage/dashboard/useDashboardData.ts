import {
  fetchCashflowStatementJson,
  fetchPayableAgingJson,
  fetchProfitLossJson,
  fetchReceivableAgingJson,
} from '@bigcapital/sdk-ts';
import { useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { sampleAging, sampleCashFlow, sampleProfitLoss } from './sampleData';
import { selectAging, selectCashFlow, selectProfitLoss } from './selectors';
import type {
  CashflowStatementJsonQuery,
  PayableAgingJsonQuery,
  ProfitLossJsonQuery,
  ReceivableAgingJsonQuery,
} from '@bigcapital/sdk-ts';
import type { DateRange, Granularity } from './ranges';
import type {
  AgingSummary,
  CashFlowSummary,
  ProfitLossSummary,
} from './selectors';
import { useApiFetcher } from '@/hooks/useRequest';

const STALE_TIME_MS = 60 * 1000;

/** `data`: populated charts. `empty`: every figure zero, to check empty states. */
export type SampleMode = 'data' | 'empty' | null;

/**
 * Sample data is a design-preview aid: dev builds only, and only when the URL
 * carries `?sample=1` (or `?sample=empty`). Production builds can never show it.
 */
export function useSampleMode(): SampleMode {
  const { search } = useLocation();
  if (!import.meta.env.DEV) return null;
  const value = new URLSearchParams(search).get('sample');
  return value === 'empty' ? 'empty' : value === '1' ? 'data' : null;
}

interface UseDashboardDataArgs {
  range: DateRange;
  granularity: Granularity;
  sample: SampleMode;
}

/**
 * Loads everything the dashboard draws. Each widget has its own query, so one
 * report failing (for example, missing permission) leaves the others intact.
 */
export function useDashboardData({
  range,
  granularity,
  sample,
}: UseDashboardDataArgs) {
  const fetcher = useApiFetcher({ enableCamelCaseTransform: true });

  // The report endpoints take snake_case, like the report pages send.
  const periodQuery = {
    from_date: range.from,
    to_date: range.to,
    display_columns_type: 'date_periods',
    display_columns_by: granularity,
  };
  const agingQuery = {
    as_date: range.to,
    aging_days_before: 30,
    aging_periods: 3,
  };

  const common = { staleTime: STALE_TIME_MS, retry: 1 } as const;

  const profitLoss = useQuery<unknown, Error, ProfitLossSummary>({
    ...common,
    queryKey: ['DASHBOARD', 'PROFIT_LOSS', periodQuery, sample],
    queryFn: async (): Promise<unknown> =>
      sample
        ? sampleProfitLoss(range, granularity, sample === 'empty')
        : fetchProfitLossJson(
            fetcher,
            periodQuery as unknown as ProfitLossJsonQuery,
          ),
    select: useCallback(
      (response: unknown) => selectProfitLoss(response, granularity),
      [granularity],
    ),
  });

  const cashFlow = useQuery<unknown, Error, CashFlowSummary>({
    ...common,
    queryKey: ['DASHBOARD', 'CASH_FLOW', periodQuery, sample],
    queryFn: async (): Promise<unknown> =>
      sample
        ? sampleCashFlow(range, granularity, sample === 'empty')
        : fetchCashflowStatementJson(
            fetcher,
            periodQuery as unknown as CashflowStatementJsonQuery,
          ),
    select: useCallback(
      (response: unknown) => selectCashFlow(response, granularity),
      [granularity],
    ),
  });

  const receivables = useQuery<unknown, Error, AgingSummary>({
    ...common,
    queryKey: ['DASHBOARD', 'RECEIVABLES', agingQuery, sample],
    queryFn: async (): Promise<unknown> =>
      sample
        ? sampleAging('receivable', range.to, sample === 'empty')
        : fetchReceivableAgingJson(
            fetcher,
            agingQuery as unknown as ReceivableAgingJsonQuery,
          ),
    select: selectAging,
  });

  const payables = useQuery<unknown, Error, AgingSummary>({
    ...common,
    queryKey: ['DASHBOARD', 'PAYABLES', agingQuery, sample],
    queryFn: async (): Promise<unknown> =>
      sample
        ? sampleAging('payable', range.to, sample === 'empty')
        : fetchPayableAgingJson(
            fetcher,
            agingQuery as unknown as PayableAgingJsonQuery,
          ),
    select: selectAging,
  });

  return { profitLoss, cashFlow, receivables, payables };
}
