import { Group } from '@visx/group';
import { ParentSize } from '@visx/responsive';
import { scaleBand, scaleLinear } from '@visx/scale';
import { useMemo, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import { ChartTooltip } from './ChartTooltip';
import { chartCssVars } from './chart-theme';
import { formatCompact, tickEvery } from './format';
import type { ChartDatum, ChartSeries } from './AreaLineChart';
import '@/style/components/Charts.scss';

interface GroupedBarChartProps {
  data: ChartDatum[];
  series: ChartSeries[];
  height?: number;
  formatValue: (value: number) => string;
  formatAxis?: (value: number) => string;
  ariaLabel: string;
}

const MARGIN = { top: 14, right: 12, bottom: 28, left: 48 };
const MAX_RADIUS = 6;

/** A bar with rounded top corners only, so it grows out of the baseline. */
const roundedTopBar = (x: number, y: number, w: number, h: number) => {
  const r = Math.max(0, Math.min(MAX_RADIUS, w / 2, h));
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
};

/** Categories compared side by side, one bar per series. */
export function GroupedBarChart({
  height = 240,
  ...props
}: GroupedBarChartProps) {
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
}: Omit<GroupedBarChartProps, 'height'> & { width: number; height: number }) {
  const [active, setActive] = useState<number | null>(null);

  const count = data.length;
  const innerWidth = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerHeight = Math.max(0, height - MARGIN.top - MARGIN.bottom);

  const indices = useMemo(() => data.map((_, index) => index), [data]);
  const xScale = useMemo(
    () =>
      scaleBand<number>({
        domain: indices,
        range: [0, innerWidth],
        paddingInner: 0.32,
        paddingOuter: 0.16,
      }),
    [indices, innerWidth],
  );
  const seriesScale = useMemo(
    () =>
      scaleBand<string>({
        domain: series.map((s) => s.key),
        range: [0, xScale.bandwidth()],
        padding: 0.14,
      }),
    [series, xScale],
  );
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
  const labelEvery = tickEvery(count, innerWidth, 56);
  const revealKey = useMemo(
    () => data.map((d) => series.map((s) => d[s.key]).join(',')).join('|'),
    [data, series],
  );

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
  const bandCenter = (index: number) =>
    (xScale(index) ?? 0) + xScale.bandwidth() / 2;

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
        <Group left={MARGIN.left} top={MARGIN.top}>
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

          {active != null && (
            <rect
              className="chart__band"
              x={(xScale(active) ?? 0) - xScale.step() * 0.08}
              width={xScale.bandwidth() + xScale.step() * 0.16}
              y={0}
              height={innerHeight}
              rx={10}
              style={{ fill: chartCssVars.track }}
            />
          )}

          <g key={revealKey}>
            {data.map((d, index) =>
              series.map((s, seriesIndex) => {
                const value = Number(d[s.key]) || 0;
                const barHeight = Math.abs(yScale(0) - yScale(value));
                if (barHeight < 1) return null;
                const x = (xScale(index) ?? 0) + (seriesScale(s.key) ?? 0);
                const y = value >= 0 ? yScale(value) : yScale(0);
                return (
                  <path
                    key={`${index}-${s.key}`}
                    className="chart__bar"
                    d={roundedTopBar(x, y, seriesScale.bandwidth(), barHeight)}
                    style={
                      {
                        fill: s.color,
                        '--i': index * series.length + seriesIndex,
                      } as CSSProperties
                    }
                  />
                );
              }),
            )}
          </g>

          {data.map((d, index) =>
            index % labelEvery === 0 || index === count - 1 ? (
              <text
                key={index}
                className="chart__tick"
                x={bandCenter(index)}
                y={innerHeight + 18}
                textAnchor="middle"
              >
                {d.label}
              </text>
            ) : null,
          )}

          {/* One hit target per band keeps hover stable between the bars. */}
          {indices.map((index) => (
            <rect
              key={index}
              x={(xScale(index) ?? 0) - xScale.step() * 0.08}
              width={xScale.bandwidth() + xScale.step() * 0.16}
              y={0}
              height={innerHeight}
              fill="transparent"
              onPointerEnter={() => setActive(index)}
              onPointerDown={() => setActive(index)}
              onPointerLeave={() => setActive(null)}
            />
          ))}
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
            left: MARGIN.left + bandCenter(active),
            top: MARGIN.top,
            transform:
              bandCenter(active) > innerWidth * 0.55
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
