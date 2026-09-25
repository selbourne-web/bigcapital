import { Group } from '@visx/group';
import { Pie } from '@visx/shape';
import { useState } from 'react';
import { chartCssVars } from './chart-theme';
import { formatPercent } from './format';
import '@/style/components/Charts.scss';

export interface DonutSlice {
  key: string;
  label: string;
  value: number;
  /** A `chartCssVars` colour. */
  color: string;
}

interface DonutChartProps {
  slices: DonutSlice[];
  /** Small caption in the ring, e.g. "Total". Replaced by the hovered slice label. */
  centerLabel: string;
  /** Value shown under the caption. Replaced by the hovered slice value. */
  centerValue: string;
  formatValue: (value: number) => string;
  ariaLabel: string;
  emptyLabel?: string;
  size?: number;
}

const THICKNESS = 22;

/**
 * Part-to-whole ring with a legend. Hovering (or focusing) a legend row
 * highlights its slice and shows its value in the centre.
 */
export function DonutChart({
  slices,
  centerLabel,
  centerValue,
  formatValue,
  ariaLabel,
  emptyLabel = 'No data',
  size = 176,
}: DonutChartProps) {
  const [activeKey, setActiveKey] = useState<string | null>(null);

  const visible = slices.filter((slice) => slice.value > 0);
  const total = visible.reduce((sum, slice) => sum + slice.value, 0);
  const isEmpty = total <= 0;
  const activeSlice = visible.find((slice) => slice.key === activeKey);

  const radius = size / 2;
  const innerRadius = radius - THICKNESS;

  return (
    <div className="donut">
      <div
        className="donut__ring"
        style={{ width: size, height: size }}
        role="img"
        aria-label={ariaLabel}
      >
        <svg width={size} height={size} aria-hidden="true">
          <Group top={radius} left={radius}>
            {isEmpty ? (
              <circle
                r={radius - THICKNESS / 2}
                fill="none"
                strokeWidth={THICKNESS}
                style={{ stroke: chartCssVars.track }}
              />
            ) : (
              <Pie
                data={visible}
                pieValue={(slice) => slice.value}
                pieSort={null}
                outerRadius={radius}
                innerRadius={innerRadius}
                padAngle={visible.length > 1 ? 0.02 : 0}
                cornerRadius={6}
              >
                {(pie) =>
                  pie.arcs.map((arc) => {
                    const slice = arc.data;
                    const dimmed = activeKey != null && activeKey !== slice.key;
                    return (
                      <path
                        key={slice.key}
                        className="donut__slice"
                        d={pie.path(arc) ?? undefined}
                        style={{
                          fill: slice.color,
                          opacity: dimmed ? 0.35 : 1,
                        }}
                        onPointerEnter={() => setActiveKey(slice.key)}
                        onPointerLeave={() => setActiveKey(null)}
                      />
                    );
                  })
                }
              </Pie>
            )}
          </Group>
        </svg>
        <div className="donut__center" aria-hidden="true">
          <span className="donut__center-label">
            {isEmpty ? emptyLabel : (activeSlice?.label ?? centerLabel)}
          </span>
          {!isEmpty && (
            <span className="donut__center-value">
              {activeSlice ? formatValue(activeSlice.value) : centerValue}
            </span>
          )}
        </div>
      </div>

      <ul className="donut__legend">
        {visible.map((slice) => (
          <li
            key={slice.key}
            className={
              activeKey === slice.key
                ? 'donut__legend-item is-active'
                : 'donut__legend-item'
            }
            tabIndex={0}
            onPointerEnter={() => setActiveKey(slice.key)}
            onPointerLeave={() => setActiveKey(null)}
            onFocus={() => setActiveKey(slice.key)}
            onBlur={() => setActiveKey(null)}
          >
            <span
              className="donut__swatch"
              style={{ background: slice.color }}
            />
            <span className="donut__legend-label">{slice.label}</span>
            <span className="donut__legend-value">
              {formatValue(slice.value)}
            </span>
            <span className="donut__legend-share">
              {formatPercent(slice.value / total)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
