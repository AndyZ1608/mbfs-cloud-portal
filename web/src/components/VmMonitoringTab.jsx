import React, { useState } from 'react';
import { Activity, Cpu, HardDrive, MemoryStick, Network, RefreshCw, Wifi } from 'lucide-react';
import { useI18n } from '../i18n/react.jsx';
import { intlLocale } from '../i18n/index.js';
import { chartPoints, emptyVmMonitoring, formatBytes, formatBytesPerSecond,
  formatPercent, hasMonitoringData, MONITORING_RANGES } from '../monitoring/model.js';
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

function MetricSummaryCard({ title, Icon, value, detail, pairs }) {
  return <div className="monitoring-summary-card">
    <div className="monitoring-summary-label"><Icon size={17} aria-hidden="true" /><span>{title}</span></div>
    {value != null && <strong>{value}</strong>}
    {detail && <small>{detail}</small>}
    {pairs && <div className="monitoring-summary-pairs">{pairs.map(([label, amount]) =>
      <div key={label}><span>{label}</span><b>{amount}</b></div>)}</div>}
  </div>;
}

function MetricChart({ title, series, locale, t }) {
  const segments = (items) => {
    const groups = [];
    let current = [];
    for (const point of Array.isArray(items) ? items : []) {
      if (Number.isFinite(point?.timestamp) && Number.isFinite(point?.value)) current.push(point);
      else if (current.length) { groups.push(chartPoints(current)); current = []; }
    }
    if (current.length) groups.push(chartPoints(current));
    return groups;
  };
  const lines = series.map((item) => ({ ...item, segments: segments(item.points) })).filter((item) => item.segments.length);
  if (!lines.length) return <section className="monitoring-chart-card" aria-label={title}>
    <h4>{title}</h4><div className="monitoring-chart-empty"><Activity size={22} aria-hidden="true" />
      <span>{t('monitoring.chartEmpty')}</span></div>
  </section>;

  const points = lines.flatMap((line) => line.segments.flat());
  const first = Math.min(...points.map((point) => point.timestamp));
  const last = Math.max(...points.map((point) => point.timestamp));
  const maximum = Math.max(1, ...points.map((point) => point.value));
  const x = (timestamp) => 38 + ((timestamp - first) / (last - first || 1)) * 584;
  const y = (amount) => 142 - (Math.max(0, amount) / maximum) * 112;
  const time = (timestamp) => new Date(timestamp).toLocaleString(locale, {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  return <section className="monitoring-chart-card" aria-label={title}>
    <div className="monitoring-chart-heading"><h4>{title}</h4><div className="monitoring-chart-legend">
      {lines.map((line) => <span key={line.key}><i style={{ background: line.color }} />{line.label}</span>)}
    </div></div>
    <svg className="monitoring-chart" viewBox="0 0 660 186" role="img" aria-label={title} preserveAspectRatio="none">
      {[30, 86, 142].map((level) => <line key={level} x1="38" x2="622" y1={level} y2={level} className="monitoring-chart-grid" />)}
      {lines.map((line) => <g key={line.key}>
        {line.segments.map((segment, index) => <g key={index}>
          {segment.length > 1 && <polyline fill="none" stroke={line.color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round"
            points={segment.map((point) => `${x(point.timestamp)},${y(point.value)}`).join(' ')} />}
          {segment.length === 1 && <circle cx={x(segment[0].timestamp)} cy={y(segment[0].value)} r="4" fill={line.color} />}
        </g>)}
      </g>)}
      <text x="38" y="174" className="monitoring-chart-axis">{time(first)}</text>
      <text x="622" y="174" textAnchor="end" className="monitoring-chart-axis">{time(last)}</text>
    </svg>
  </section>;
}

export function MonitoringView({ status, data, error, range, onRangeChange, onRefresh }) {
  const { t, locale } = useI18n();
  const numberLocale = intlLocale(locale);
  const toolbar = <MonitoringToolbar range={range} onRangeChange={onRangeChange}
    onRefresh={onRefresh} status={status} t={t} />;

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
  const bothMissing = (a, b) => !Number.isFinite(a) && !Number.isFinite(b);
  const diskRead = formatBytesPerSecond(summary.diskReadBps, numberLocale);
  const diskWrite = formatBytesPerSecond(summary.diskWriteBps, numberLocale);
  const networkRx = formatBytesPerSecond(summary.networkRxBps, numberLocale);
  const networkTx = formatBytesPerSecond(summary.networkTxBps, numberLocale);
  const memoryDetail = Number.isFinite(summary.memoryUsedBytes) && Number.isFinite(summary.memoryTotalBytes)
    ? `${formatBytes(summary.memoryUsedBytes, numberLocale)} / ${formatBytes(summary.memoryTotalBytes, numberLocale)}` : null;
  const charts = [
    { key: 'cpu', title: t('monitoring.cpuUsage'), lines: [
      { key: 'cpuPercent', label: t('monitoring.cpu'), color: 'var(--accent)', points: series.cpuPercent },
    ] },
    { key: 'memory', title: t('monitoring.memoryUsage'), lines: [
      { key: 'memoryPercent', label: t('monitoring.memory'), color: 'var(--info)', points: series.memoryPercent },
    ] },
    { key: 'disk', title: t('monitoring.diskIo'), lines: [
      { key: 'diskReadBps', label: t('monitoring.read'), color: 'var(--accent)', points: series.diskReadBps },
      { key: 'diskWriteBps', label: t('monitoring.write'), color: 'var(--warn)', points: series.diskWriteBps },
    ] },
    { key: 'network', title: t('monitoring.networkTraffic'), lines: [
      { key: 'networkRxBps', label: t('monitoring.receive'), color: 'var(--accent)', points: series.networkRxBps },
      { key: 'networkTxBps', label: t('monitoring.transmit'), color: 'var(--ok)', points: series.networkTxBps },
    ] },
  ];

  return <div className="vm-monitoring">{toolbar}
    {noData && <p className="monitoring-notice" role="status">{t('monitoring.noData')}</p>}
    {metrics.historyUnsupported && <p className="monitoring-notice" role="status">{t('monitoring.historyUnsupported')}</p>}
    {metrics.partial && <p className="monitoring-notice" role="status">{t('monitoring.historyPartial')}</p>}
    <div className="monitoring-summary-grid">
      <MetricSummaryCard title={t('monitoring.cpuUsage')} Icon={Cpu} value={formatPercent(summary.cpuPercent, numberLocale)} />
      <MetricSummaryCard title={t('monitoring.memoryUsage')} Icon={MemoryStick}
        value={formatPercent(summary.memoryPercent, numberLocale)} detail={memoryDetail} />
      <MetricSummaryCard title={t('monitoring.diskIo')} Icon={HardDrive}
        value={bothMissing(summary.diskReadBps, summary.diskWriteBps) ? 'N/A' : null}
        pairs={[[t('monitoring.read'), diskRead], [t('monitoring.write'), diskWrite]]} />
      <MetricSummaryCard title={t('monitoring.network')} Icon={Network}
        value={bothMissing(summary.networkRxBps, summary.networkTxBps) ? 'N/A' : null}
        pairs={[[t('monitoring.receive'), networkRx], [t('monitoring.transmit'), networkTx]]} />
      <MetricSummaryCard title={t('monitoring.reachability')} Icon={Wifi}
        value={summary.reachable === true ? t('monitoring.reachable')
          : summary.reachable === false ? t('monitoring.unreachable')
            : summary.reachable === 'unknown' ? t('monitoring.unknown') : 'N/A'} />
    </div>
    <div className="monitoring-chart-grid-layout">{charts.map((chart) => <MetricChart key={chart.key}
      title={chart.title} series={chart.lines} locale={numberLocale} t={t} />)}</div>
  </div>;
}

export default function VmMonitoringTab({ projectId, instanceId }) {
  const [range, setRange] = useState('1h');
  const monitoring = useVmMonitoring({ projectId, instanceId, range });
  return <MonitoringView status={monitoring.status} data={monitoring.data} error={monitoring.error} range={range}
    onRangeChange={setRange} onRefresh={monitoring.refresh} />;
}
