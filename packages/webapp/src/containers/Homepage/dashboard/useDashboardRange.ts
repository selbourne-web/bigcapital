import { useCallback, useMemo, useState } from 'react';
import { DEFAULT_RANGE, pickGranularity, resolveRange } from './ranges';
import type { DateRange, Granularity, RangeSelection } from './ranges';
import { useCurrentOrganizationMetadata } from '@/hooks/query';

const STORAGE_KEY = 'dashboard-range';

/** Storage can be unavailable (private mode, blocked); the dashboard must still work. */
const readStored = (): RangeSelection => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULT_RANGE, ...JSON.parse(raw) } : DEFAULT_RANGE;
  } catch {
    return DEFAULT_RANGE;
  }
};

const writeStored = (selection: RangeSelection) => {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(selection));
  } catch {
    // Not persisting the selection is fine.
  }
};

export interface DashboardRangeState {
  selection: RangeSelection;
  range: DateRange;
  granularity: Granularity;
  setSelection: (selection: RangeSelection) => void;
}

/**
 * The dashboard's selected date range. It is remembered per browser, and
 * relative presets are re-resolved on every visit so "This month" stays current.
 */
export function useDashboardRange(): DashboardRangeState {
  const fiscalYear = useCurrentOrganizationMetadata()?.fiscalYear;
  const [selection, setSelectionState] = useState<RangeSelection>(readStored);

  const setSelection = useCallback((next: RangeSelection) => {
    setSelectionState(next);
    writeStored(next);
  }, []);

  const range = useMemo(
    () => resolveRange(selection, fiscalYear),
    [selection, fiscalYear],
  );
  const granularity = useMemo(() => pickGranularity(range), [range]);

  return { selection, range, granularity, setSelection };
}
