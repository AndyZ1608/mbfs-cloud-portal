import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Activity, Cpu, HardDrive, MemoryStick, Network, RefreshCw, Wifi } from 'lucide-react';
import { useI18n } from '../i18n/react.jsx';
import { intlLocale } from '../i18n/index.js';
import { emptyVmMonitoring, formatBytes, formatBytesPerSecond, formatMonitoringRate,
  formatPercent, hasMonitoringData, MONITORING_RANGES } from '../monitoring/model.js';
import { chartMaximum, chartSamples, chartTimeTicks, formatAxisTimestamp, formatChartValue,
  formatFullTimestamp, formatSampleTime, hoverTimestampAt, recordedTimestamps, recordedValuesAt,
  sampleTolerance } from '../monitoring/chart.js';
import useVmMonitoring from '../monitoring/useVmMonitoring.js';

export function TimeRangeSelector({ range, onChange, t }) {
  return <div className="monitoring-ranges" role="group" aria-label={t('monitoring.rangeLabel')}>
    {MONITORING_RANGES.map((option) => <button key={option} type="button" aria-pressed={range === option}
      className={range === option ? 'selected' : ''} onClick={() => onChange(option)}>
      {t(`monitoring.range.${option}`)}
    </button>)}
  </div>;
}

export function MonitoringToolbar({ range, onRangeChange, onRefresh, status, t }) {
  return <div className="monitoring-toolbar">
    <h3>{t('monitoring.title')}</h3>
    <div className="monitoring-toolbar-actions"><TimeRangeSelector range={range} onChange={onRangeChange} t={t} />
      <button className="btn ghost sm" type="button" onClick={onRefresh} disabled={status === 'loading'}>
        <RefreshCw size={14} aria-hidden="true" />{t('common.refresh')}
      </button></div>
  </div>;
}

export const MONITORING_CATEGORIES = Object.freeze(['compute', 'network', 'storage']);

export function MonitoringCategorySelector({ category, onChange, t, panelId = 'monitoring-category-panel' }) {
  function onKeyDown(event, current) {
    const index = MONITORING_CATEGORIES.indexOf(current);
    const next = event.key === 'ArrowRight' ? (index + 1) % MONITORING_CATEGORIES.length
      : event.key === 'ArrowLeft' ? (index + MONITORING_CATEGORIES.length - 1) % MONITORING_CATEGORIES.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? MONITORING_CATEGORIES.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    onChange(MONITORING_CATEGORIES[next]);
    event.currentTarget.parentElement?.querySelectorAll('[role="tab"]')[next]?.focus();
  }
  return <div className="monitoring-category-tabs" role="tablist" aria-label={t('monitoring.categoryLabel')}>
    {MONITORING_CATEGORIES.map((item) => <button key={item} type="button" role="tab"
      id={`${panelId}-${item}`} aria-controls={panelId} aria-selected={category === item}
      tabIndex={category === item ? 0 : -1} className={category === item ? 'selected' : ''}
      onClick={() => onChange(item)} onKeyDown={(event) => onKeyDown(event, item)}>
      {t(`monitoring.category.${item}`)}
    </button>)}
  </div>;
}

function MetricSummaryCard({ title, Icon, value, detail, pairs }) {
  return <div className="monitoring-summary-card">
    <div className="monitoring-summary-label"><Icon size={17} aria-hidden="true" /><span>{title}</span></div>
    {value != null && <strong>{value}</strong>}
    {detail && <small>{detail}</small>}
    {pairs && <div className="monitoring-summary-pairs">{pairs.map(([label, amount]) =>
      <div key={label}><span>{label}</span><b>{amount}</b></div>)}</div>}
  </div>;
}

const CHART_TOP = 14;
const CHART_BOTTOM = 172;
const CHART_LEFT = 64;
const CHART_HEIGHT = 226;

function chartSegments(samples) {
  const groups = [];
  let current = [];
  for (const point of samples) {
    if (Number.isFinite(point.value)) current.push(point);
    else if (current.length) { groups.push(current); current = []; }
  }
  if (current.length) groups.push(current);
  return groups;
}

export function ChartTooltip({ id, timestamp, selected, unit, locale, left }) {
  if (!selected.length) return null;
  return <div id={id} className="monitoring-chart-tooltip" role="tooltip" style={{ left }}>
    <strong>{formatFullTimestamp(timestamp, locale)}</strong>
    {selected.map(({ key, label, color, point }) => <div key={key} className="monitoring-chart-tooltip-row">
      <span className="monitoring-chart-tooltip-label"><i style={{ background: color }} />{label}</span>
      <span><b>{formatChartValue(point.value, unit, locale)}</b>
        {point.timestamp !== timestamp && <small>{formatSampleTime(point.timestamp, locale)}</small>}</span>
    </div>)}
  </div>;
}

function InteractiveChart({ title, series, unit, range, locale, t }) {
  const wrapperRef = useRef(null);
  const svgRef = useRef(null);
  const tooltipId = useId();
  const [width, setWidth] = useState(660);
  const [hover, setHover] = useState(null);
  const lines = useMemo(() => series.map((line) => {
    const samples = chartSamples(line.points);
    const fallback = (range === '24h' ? 120_000 : range === '7d' ? 86_400_000 : 60_000) * 0.49;
    return { ...line, samples, segments: chartSegments(samples), toleranceMs: sampleTolerance(samples) || fallback };
  }).filter((line) => line.segments.length), [series, range]);
  const times = useMemo(() => recordedTimestamps(lines), [lines]);

  useEffect(() => {
    const element = wrapperRef.current;
    if (!element) return undefined;
    const update = () => setWidth((previous) => {
      const measured = Math.max(220, Math.round(element.getBoundingClientRect().width || 660));
      return previous === measured ? previous : measured;
    });
    update();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => setHover(null), [lines]);

  const first = times[0];
  const last = times.at(-1);
  const plotRight = width - 12;
  const plotWidth = plotRight - CHART_LEFT;
  const maximum = useMemo(() => chartMaximum(lines.flatMap((line) => line.samples.map((point) => point.value)), unit),
    [lines, unit]);
  const x = (timestamp) => CHART_LEFT + ((timestamp - first) / (last - first || 1)) * plotWidth;
  const y = (amount) => CHART_BOTTOM - (Math.max(0, amount) / maximum) * (CHART_BOTTOM - CHART_TOP);
  const ticks = useMemo(() => chartTimeTicks(first, last, range, plotWidth), [first, last, range, plotWidth]);
  const selected = hover ? recordedValuesAt(lines, hover.timestamp) : [];

  function selectAt(clientX) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect?.width) return;
    const timestamp = hoverTimestampAt(times, clientX, { left: rect.left, width: rect.width,
      viewWidth: width, plotLeft: CHART_LEFT, plotRight });
    if (timestamp !== null) setHover((previous) => previous?.timestamp === timestamp && previous.source === 'pointer'
      ? previous : { timestamp, source: 'pointer' });
    else setHover(null);
  }

  function onKeyDown(event) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Escape') { setHover(null); return; }
    const current = times.indexOf(hover?.timestamp);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? times.length - 1
      : event.key === 'ArrowLeft' ? Math.max(0, (current < 0 ? 0 : current) - 1)
        : Math.min(times.length - 1, current + 1);
    setHover({ timestamp: times[index], source: 'keyboard' });
  }

  return <div className="monitoring-chart-plot" ref={wrapperRef}>
    <svg ref={svgRef} className="monitoring-chart" viewBox={`0 0 ${width} ${CHART_HEIGHT}`}
      role="img" tabIndex={0} aria-label={`${title}. ${t('monitoring.chartKeyboardHint')}`}
      aria-describedby={hover ? tooltipId : undefined}
      onPointerMove={(event) => selectAt(event.clientX)} onPointerLeave={() => setHover(null)}
      onFocus={() => setHover((previous) => previous || { timestamp: times[0], source: 'keyboard' })}
      onBlur={() => setHover(null)} onKeyDown={onKeyDown}>
      {[maximum, maximum / 2, 0].map((amount) => <g key={amount}>
        <line x1={CHART_LEFT} x2={plotRight} y1={y(amount)} y2={y(amount)} className="monitoring-chart-grid" />
        <text x={CHART_LEFT - 8} y={y(amount) + 4} textAnchor="end" className="monitoring-chart-axis">
          {formatChartValue(amount, unit, locale)}</text>
      </g>)}
      {ticks.map((timestamp) => <g key={timestamp}>
        <line x1={x(timestamp)} x2={x(timestamp)} y1={CHART_BOTTOM} y2={CHART_BOTTOM + 4} className="monitoring-chart-grid" />
        <text x={x(timestamp)} y={CHART_BOTTOM + 22}
          textAnchor={Math.abs(timestamp - first) < 1 ? 'start' : Math.abs(timestamp - last) < 1 ? 'end' : 'middle'}
          className="monitoring-chart-axis">{formatAxisTimestamp(timestamp, range, locale)}</text>
      </g>)}
      {lines.map((line) => <g key={line.key}>
        {line.segments.map((segment, index) => <g key={index}>
          {segment.length > 1 && <polyline fill="none" stroke={line.color} strokeWidth="2.5"
            strokeLinejoin="round" strokeLinecap="round"
            points={segment.map((point) => `${x(point.timestamp)},${y(point.value)}`).join(' ')} />}
          {segment.length === 1 && <circle cx={x(segment[0].timestamp)} cy={y(segment[0].value)} r="4" fill={line.color} />}
        </g>)}
      </g>)}
      {hover && <g pointerEvents="none">
        <line x1={x(hover.timestamp)} x2={x(hover.timestamp)} y1={CHART_TOP} y2={CHART_BOTTOM}
          className="monitoring-chart-crosshair" />
        {selected.map(({ key, color, point }) => <circle key={key} cx={x(point.timestamp)} cy={y(point.value)}
          r="5" fill={color} className="monitoring-chart-active-point" />)}
      </g>}
    </svg>
    {hover && selected.length > 0 && <ChartTooltip id={tooltipId} timestamp={hover.timestamp} selected={selected}
      unit={unit} locale={locale}
      left={Math.min(Math.max(8, x(hover.timestamp) + 12), Math.max(8, width - 228))} />}
    <span className="monitoring-chart-screenreader" aria-live="polite">{hover?.source === 'keyboard' && selected.length
      ? `${formatFullTimestamp(hover.timestamp, locale)}. ${selected.map(({ label, point }) =>
        `${label}: ${formatChartValue(point.value, unit, locale)}`).join('. ')}` : ''}</span>
  </div>;
}

export function MetricChart({ title, series, unit, range, locale, t }) {
  const hasData = series.some((line) => Array.isArray(line.points) && line.points.some((point) =>
    Number.isFinite(point?.timestamp) && Number.isFinite(point?.value)));
  if (!hasData) return <section className="monitoring-chart-card" aria-label={title}>
    <h4>{title}</h4><div className="monitoring-chart-empty"><Activity size={22} aria-hidden="true" />
      <span>{t('monitoring.chartEmpty')}</span></div>
  </section>;
  return <section className="monitoring-chart-card" aria-label={title}>
    <div className="monitoring-chart-heading"><h4>{title}</h4><div className="monitoring-chart-legend">
      {series.filter((line) => line.points?.some((point) => Number.isFinite(point?.value)))
        .map((line) => <span key={line.key}><i style={{ background: line.color }} />{line.label}</span>)}
    </div></div>
    <InteractiveChart title={title} series={series} unit={unit} range={range} locale={locale} t={t} />
  </section>;
}

export function MonitoringView({ status, data, error, range, onRangeChange, onRefresh,
  category = 'compute', onCategoryChange = () => {} }) {
  const { t, locale } = useI18n();
  const numberLocale = intlLocale(locale);
  const panelId = useId();
  const selectedCategory = MONITORING_CATEGORIES.includes(category) ? category : 'compute';
  const toolbar = <MonitoringToolbar range={range} onRangeChange={onRangeChange}
    onRefresh={onRefresh} status={status} t={t} />;
  const selector = <MonitoringCategorySelector category={selectedCategory} onChange={onCategoryChange}
    panelId={panelId} t={t} />;

  if (status === 'loading') return <div className="vm-monitoring">{toolbar}
    <div className="monitoring-loading" role="status">{t('monitoring.loading')}</div></div>;
  if (status === 'error') return <div className="vm-monitoring">{toolbar}
    <div className="vm-detail-error" role="alert">{['monitoring_unavailable', 'monitoring_timeout'].includes(error?.code)
      ? t('monitoring.serviceUnavailable') : t('monitoring.loadError')}
      <button className="btn ghost sm" type="button" onClick={onRefresh}>{t('common.retry')}</button></div></div>;

  const metrics = data || emptyVmMonitoring();
  const summary = metrics.summary || {};
  const series = metrics.series || {};
  const noData = !hasMonitoringData(metrics);
  const memoryDetail = Number.isFinite(summary.memoryUsedBytes) && Number.isFinite(summary.memoryTotalBytes)
    ? `${formatBytes(summary.memoryUsedBytes, numberLocale)} / ${formatBytes(summary.memoryTotalBytes, numberLocale)}` : null;
  const reachability = summary.reachable === true ? t('monitoring.reachable')
    : summary.reachable === false ? t('monitoring.unreachable')
      : summary.reachable === 'unknown' ? t('monitoring.unknown') : null;
  const charts = {
    compute: [
      { key: 'cpu', title: t('monitoring.cpuUtilization'), unit: 'percent', lines: [
        { key: 'cpuPercent', label: t('monitoring.cpu'), color: 'var(--accent)', points: series.cpuPercent },
      ] },
      { key: 'memory', title: t('monitoring.memoryUtilization'), unit: 'percent', lines: [
        { key: 'memoryPercent', label: t('monitoring.memory'), color: 'var(--info)', points: series.memoryPercent },
      ] },
    ],
    network: [
      { key: 'network', title: t('monitoring.networkThroughput'), unit: 'throughput', lines: [
        { key: 'networkRxBps', label: t('monitoring.receive'), color: 'var(--accent)', points: series.networkRxBps },
        { key: 'networkTxBps', label: t('monitoring.transmit'), color: 'var(--ok)', points: series.networkTxBps },
      ] },
      { key: 'packets', title: t('monitoring.networkPacketRate'), unit: 'pps', lines: [
        { key: 'networkRxPps', label: t('monitoring.rxPps'), color: 'var(--accent)', points: series.networkRxPps },
        { key: 'networkTxPps', label: t('monitoring.txPps'), color: 'var(--ok)', points: series.networkTxPps },
      ] },
      { key: 'drops', title: t('monitoring.packetDrops'), unit: 'drops/s', lines: [
        { key: 'networkRxDropsPerSec', label: t('monitoring.rxDrops'), color: 'var(--accent)', points: series.networkRxDropsPerSec },
        { key: 'networkTxDropsPerSec', label: t('monitoring.txDrops'), color: 'var(--warn)', points: series.networkTxDropsPerSec },
      ] },
    ],
    storage: [
      { key: 'disk', title: t('monitoring.diskThroughput'), unit: 'throughput', lines: [
        { key: 'diskReadBps', label: t('monitoring.read'), color: 'var(--accent)', points: series.diskReadBps },
        { key: 'diskWriteBps', label: t('monitoring.write'), color: 'var(--warn)', points: series.diskWriteBps },
      ] },
      { key: 'latency', title: t('monitoring.storageLatency'), unit: 'ms/op', lines: [
        { key: 'diskReadLatencyMs', label: t('monitoring.readLatency'), color: 'var(--accent)', points: series.diskReadLatencyMs },
        { key: 'diskWriteLatencyMs', label: t('monitoring.writeLatency'), color: 'var(--warn)', points: series.diskWriteLatencyMs },
      ] },
    ],
  };

  return <div className="vm-monitoring">{toolbar}{selector}
    {noData && <p className="monitoring-notice" role="status">{t('monitoring.noData')}</p>}
    {metrics.historyUnsupported && <p className="monitoring-notice" role="status">{t('monitoring.historyUnsupported')}</p>}
    {metrics.partial && <p className="monitoring-notice" role="status">{t('monitoring.historyPartial')}</p>}
    <section className="monitoring-section" data-category={selectedCategory} id={panelId} role="tabpanel"
      aria-labelledby={`${panelId}-${selectedCategory}`} tabIndex={0}>
      <div className="monitoring-section-heading">
        <h4>{t(`monitoring.section.${selectedCategory}`)}</h4>
        {selectedCategory === 'compute' && reachability && <span className="monitoring-availability">
          <Wifi size={14} aria-hidden="true" />{t('monitoring.reachability')}: <strong>{reachability}</strong>
        </span>}
      </div>
      {selectedCategory === 'compute' && <div className="monitoring-summary-grid">
        <MetricSummaryCard title={t('monitoring.cpuUsage')} Icon={Cpu}
          value={formatPercent(summary.cpuPercent, numberLocale)} />
        <MetricSummaryCard title={t('monitoring.memoryUsage')} Icon={MemoryStick}
          value={formatPercent(summary.memoryPercent, numberLocale)} detail={memoryDetail} />
      </div>}
      {selectedCategory === 'network' && <div className="monitoring-summary-grid">
        <MetricSummaryCard title={t('monitoring.networkThroughput')} Icon={Network}
          pairs={[[t('monitoring.receive'), formatBytesPerSecond(summary.networkRxBps, numberLocale)],
            [t('monitoring.transmit'), formatBytesPerSecond(summary.networkTxBps, numberLocale)]]} />
        <MetricSummaryCard title={t('monitoring.networkPacketRate')} Icon={Network}
          pairs={[[t('monitoring.rxPps'), formatMonitoringRate(summary.networkRxPps, 'pps', numberLocale)],
            [t('monitoring.txPps'), formatMonitoringRate(summary.networkTxPps, 'pps', numberLocale)]]} />
        <MetricSummaryCard title={t('monitoring.packetDrops')} Icon={Activity}
          pairs={[[t('monitoring.rxDrops'), formatMonitoringRate(summary.networkRxDropsPerSec, 'drops/s', numberLocale)],
            [t('monitoring.txDrops'), formatMonitoringRate(summary.networkTxDropsPerSec, 'drops/s', numberLocale)]]} />
      </div>}
      {selectedCategory === 'storage' && <div className="monitoring-summary-grid">
        <MetricSummaryCard title={t('monitoring.readPerformance')} Icon={HardDrive}
          pairs={[[t('monitoring.throughput'), formatBytesPerSecond(summary.diskReadBps, numberLocale)],
            [t('monitoring.latency'), formatMonitoringRate(summary.diskReadLatencyMs, 'ms/op', numberLocale)]]} />
        <MetricSummaryCard title={t('monitoring.writePerformance')} Icon={HardDrive}
          pairs={[[t('monitoring.throughput'), formatBytesPerSecond(summary.diskWriteBps, numberLocale)],
            [t('monitoring.latency'), formatMonitoringRate(summary.diskWriteLatencyMs, 'ms/op', numberLocale)]]} />
      </div>}
      <div className="monitoring-chart-grid-layout">{charts[selectedCategory].map((chart) => <MetricChart key={chart.key}
        title={chart.title} series={chart.lines} unit={chart.unit} range={range} locale={numberLocale} t={t} />)}</div>
    </section>
  </div>;
}

export default function VmMonitoringTab({ projectId, instanceId }) {
  const [range, setRange] = useState('1h');
  const [category, setCategory] = useState('compute');
  const monitoring = useVmMonitoring({ projectId, instanceId, range });
  return <MonitoringView status={monitoring.status} data={monitoring.data} error={monitoring.error} range={range}
    onRangeChange={setRange} onRefresh={monitoring.refresh}
    category={category} onCategoryChange={setCategory} />;
}
