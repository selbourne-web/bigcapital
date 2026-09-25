import type { CSSProperties, ReactNode } from 'react';

export interface ChartTooltipRow {
  label: ReactNode;
  value: ReactNode;
  color?: string;
}

interface ChartTooltipProps {
  title?: ReactNode;
  rows: ChartTooltipRow[];
  style?: CSSProperties;
}

/**
 * Tooltip surface shared by every chart. Purely presentational: the chart owns
 * hover state and positioning (and announces the active point separately, so
 * this stays out of the accessibility tree).
 */
export function ChartTooltip({ title, rows, style }: ChartTooltipProps) {
  return (
    <div className="chart-tooltip" style={style} aria-hidden="true">
      {title && <div className="chart-tooltip__title">{title}</div>}
      {rows.map((row, index) => (
        <div className="chart-tooltip__row" key={index}>
          {row.color && (
            <span
              className="chart-tooltip__swatch"
              style={{ background: row.color }}
            />
          )}
          <span className="chart-tooltip__label">{row.label}</span>
          <span className="chart-tooltip__value">{row.value}</span>
        </div>
      ))}
    </div>
  );
}
