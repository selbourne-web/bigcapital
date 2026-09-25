import { curveMonotoneX } from '@visx/curve';
import { Group } from '@visx/group';
import { ParentSize } from '@visx/responsive';
import { scaleLinear } from '@visx/scale';
import { Area, LinePath } from '@visx/shape';
import { useId, useMemo, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { ChartTooltip } from './ChartTooltip';
import { chartCssVars } from './chart-theme';
import { formatCompact, showTickLabel, tickEvery } from './format';
import '@/style/components/Charts.scss';

export interface ChartSeries {
  key: string;
  label: string;
  /** A `chartCssVars` colour. */
  color: string;
  /** Fill the region under the line with a soft gradient. */
  fill?: boolean;
}

export type ChartDatum = { label: string } & Record<string, number | string>;

interface AreaLineChartProps {
  data: ChartDatum[];
  series: ChartSeries[];
  height?: number;
  /** Full-precision value for the tooltip and the screen reader text. */
  formatValue: (value: number) => string;
  /** Short value for the y axis. */
  formatAxis?: (value: number) => string;
  ariaLabel: string;
}

const MARGIN = { top: 14, right: 16, bottom: 28, left: 48 };

/**
 * Time series as lines with optional gradient fill. Composition follows the
 * bklit-ui convention: grid, then series, then axes, then the tooltip layer.
 */
export function AreaLineChart({ height = 240, ...props }: AreaLineChartProps) {
  return (
    <div className="chart" style={{ height }}>
      <ParentSize>
        {({ width, height: parentHeight }) =>
          width > 0 && parentHeight > 0 ? (
            <Plot {...props} width={width} height={parentHeight} />
          ) : null
        }
      </ParentSize>
    </div>
  );
}

function Plot({
  data,
  series,
  width,
  height,
  formatValue,
  formatAxis = formatCompact,
  ariaLabel,
}: Omit<AreaLineChartProps, 'height'> & { width: number; height: number }) {
  const gradientId = useId().replace(/:/g, '');
  const [active, setActive] = useState<number | null>(null);

  const count = data.length;
  const innerWidth = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerHeight = Math.max(0, height - MARGIN.top - MARGIN.bottom);

  const xScale = useMemo(
    () =>
      scaleLinear<number>({
        domain: [0, Math.max(1, count - 1)],
        range: [0, innerWidth],
      }),
    [count, innerWidth],
  );
  const xAt = (index: number) => (count === 1 ? innerWidth / 2 : xScale(index));

  const yScale = useMemo(() => {
    const values = data.flatMap((d) =>
      series.map((s) => Number(d[s.key]) || 0),
    );
    const min = Math.min(0, ...values);
    const max = Math.max(0, ...values);
    return scaleLinear<number>({
      domain: [min, max === min ? 1 : max],
      range: [innerHeight, 0],
      nice: 4,
    });
  }, [data, series, innerHeight]);

  const yTicks = yScale.ticks(4);
  const labelEvery = tickEvery(count, innerWidth);

  // Replay the enter animation when the data changes, not on hover.
  const revealKey = useMemo(
    () => data.map((d) => series.map((s) => d[s.key]).join(',')).join('|'),
    [data, series],
  );

  const indexFromPointer = (event: PointerEvent<SVGRectElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (count <= 1) return 0;
    const index = Math.round(xScale.invert(event.clientX - box.left));
    return Math.min(count - 1, Math.max(0, index));
  };

  const handleKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    const last = count - 1;
    const step = (delta: number) =>
      setActive((prev) =>
        Math.min(
          last,
          Math.max(0, (prev ?? (delta > 0 ? -1 : last + 1)) + delta),
        ),
      );
    switch (event.key) {
      case 'ArrowRight':
        return event.preventDefault(), step(1);
      case 'ArrowLeft':
        return event.preventDefault(), step(-1);
      case 'Home':
        return event.preventDefault(), setActive(0);
      case 'End':
        return event.preventDefault(), setActive(last);
      case 'Escape':
        return setActive(null);
      default:
    }
  };

  const activeDatum = active != null ? data[active] : null;
  const announcement = activeDatum
    ? `${activeDatum.label}: ${series
        .map(
          (s) => `${s.label} ${formatValue(Number(activeDatum[s.key]) || 0)}`,
        )
        .join(', ')}`
    : '';

  return (
    <div className="chart__plot" style={{ width, height }}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={ariaLabel}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onBlur={() => setActive(null)}
      >
        <defs>
          {series
            .filter((s) => s.fill)
            .map((s) => (
              <linearGradient
                key={s.key}
                id={`${gradientId}-${s.key}`}
                x1="0"
                x2="0"
                y1="0"
                y2="1"
              >
                <stop
                  offset="0%"
                  style={{ stopColor: s.color, stopOpacity: 0.28 }}
                />
                <stop
                  offset="100%"
                  style={{ stopColor: s.color, stopOpacity: 0 }}
                />
              </linearGradient>
            ))}
        </defs>

        <Group left={MARGIN.left} top={MARGIN.top}>
          {/* Grid first, so series render above it. */}
          {yTicks.map((tick) => (
            <g key={tick}>
              <line
                className={tick === 0 ? 'chart__baseline' : 'chart__grid'}
                x1={0}
                x2={innerWidth}
                y1={yScale(tick)}
                y2={yScale(tick)}
                style={{ stroke: chartCssVars.grid }}
              />
              <text
                className="chart__tick"
                x={-10}
                y={yScale(tick)}
                dy="0.32em"
                textAnchor="end"
              >
                {formatAxis(tick)}
              </text>
            </g>
          ))}

          <g className="chart__reveal" key={revealKey}>
            {series.map((s) => {
              const points = data.map((d, index) => ({
                x: xAt(index),
                y: yScale(Number(d[s.key]) || 0),
              }));
              return (
                <g key={s.key}>
                  {s.fill && count > 1 && (
                    <Area
                      data={points}
                      x={(p) => p.x}
                      y0={yScale(0)}
                      y1={(p) => p.y}
                      curve={curveMonotoneX}
                      style={{ fill: `url(#${gradientId}-${s.key})` }}
                    />
                  )}
                  <LinePath
                    data={points}
                    x={(p) => p.x}
                    y={(p) => p.y}
                    curve={curveMonotoneX}
                    className="chart__line"
                    style={{ stroke: s.color }}
                  />
                  {count === 1 && (
                    <circle
                      cx={points[0].x}
                      cy={points[0].y}
                      r={4}
                      style={{ fill: s.color }}
                    />
                  )}
                </g>
              );
            })}
          </g>

          {data.map((d, index) =>
            showTickLabel(index, count, labelEvery) ? (
              <text
                key={index}
                className="chart__tick"
                x={xAt(index)}
                y={innerHeight + 18}
                textAnchor={
                  count > 1 && index === 0
                    ? 'start'
                    : count > 1 && index === count - 1
                      ? 'end'
                      : 'middle'
                }
              >
                {d.label}
              </text>
            ) : null,
          )}

          {active != null && (
            <g pointerEvents="none">
              <line
                className="chart__crosshair"
                x1={xAt(active)}
                x2={xAt(active)}
                y1={0}
                y2={innerHeight}
                style={{ stroke: chartCssVars.crosshair }}
              />
              {series.map((s) => (
                <circle
                  key={s.key}
                  className="chart__dot"
                  cx={xAt(active)}
                  cy={yScale(Number(data[active][s.key]) || 0)}
                  r={5}
                  style={{ fill: s.color }}
                />
              ))}
            </g>
          )}

          <rect
            width={innerWidth}
            height={innerHeight}
            fill="transparent"
            onPointerMove={(event) => setActive(indexFromPointer(event))}
            onPointerDown={(event) => setActive(indexFromPointer(event))}
            onPointerLeave={() => setActive(null)}
          />
        </Group>
      </svg>

      {activeDatum && active != null && (
        <ChartTooltip
          title={activeDatum.label}
          rows={series.map((s) => ({
            label: s.label,
            value: formatValue(Number(activeDatum[s.key]) || 0),
            color: s.color,
          }))}
          style={{
            left: MARGIN.left + xAt(active),
            top: MARGIN.top,
            transform:
              xAt(active) > innerWidth * 0.55
                ? 'translateX(calc(-100% - 12px))'
                : 'translateX(12px)',
          }}
        />
      )}
      <span className="chart__sr" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}
