import { RANGE_PRESETS, formatRangeLabel } from './ranges';
import type { DateRange, RangePreset, RangeSelection } from './ranges';

interface DashboardRangeSelectProps {
  selection: RangeSelection;
  /** The resolved dates for the current selection. */
  range: DateRange;
  onChange: (selection: RangeSelection) => void;
}

/**
 * Date range picker for the whole dashboard: a pill-shaped native select (for
 * built-in accessibility) with two date inputs when "Custom range" is chosen.
 */
export function DashboardRangeSelect({
  selection,
  range,
  onChange,
}: DashboardRangeSelectProps) {
  const handlePreset = (preset: RangePreset) => {
    // Switching to custom starts from the dates currently shown.
    onChange(
      preset === 'custom'
        ? { preset, customFrom: range.from, customTo: range.to }
        : { preset },
    );
  };

  return (
    <div className="dash-range">
      <label className="dash-range__field">
        <span className="dash-range__label">Date range</span>
        <select
          className="dash-range__select"
          value={selection.preset}
          onChange={(event) => handlePreset(event.target.value as RangePreset)}
        >
          {RANGE_PRESETS.map((preset) => (
            <option key={preset.value} value={preset.value}>
              {preset.label}
            </option>
          ))}
        </select>
      </label>

      {selection.preset === 'custom' ? (
        <div className="dash-range__custom">
          <input
            className="dash-range__date"
            type="date"
            aria-label="From date"
            value={selection.customFrom ?? ''}
            max={selection.customTo}
            onChange={(event) =>
              onChange({ ...selection, customFrom: event.target.value })
            }
          />
          <span aria-hidden="true">{'–'}</span>
          <input
            className="dash-range__date"
            type="date"
            aria-label="To date"
            value={selection.customTo ?? ''}
            min={selection.customFrom}
            onChange={(event) =>
              onChange({ ...selection, customTo: event.target.value })
            }
          />
        </div>
      ) : (
        <span className="dash-range__dates">{formatRangeLabel(range)}</span>
      )}
    </div>
  );
}
