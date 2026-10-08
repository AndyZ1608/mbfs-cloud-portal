import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { translate } from '../src/i18n/index.js';
import { chartPoints, emptyVmMonitoring, formatBytesPerSecond, formatPercent,
  hasMonitoringData, monitoringScopeKey, MONITORING_RANGES } from '../src/monitoring/model.js';
import { loadVmMonitoring } from '../src/monitoring/provider.js';

const source = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

test('provider calls only the CMP-owned route for each range and never sends project ID or an admin key', async () => {
  const oldFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(emptyVmMonitoring()), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const signal = new AbortController().signal;
    const data = await loadVmMonitoring({ projectId: 'project-a', instanceId: 'vm-a', range: '1h', signal });
    assert.deepEqual(data, emptyVmMonitoring());
    assert.ok(Object.values(data.summary).every((value) => value === null));
    assert.ok(Object.values(data.series).every((value) => Array.isArray(value) && value.length === 0));
    assert.equal(hasMonitoringData(data), false);
    for (const range of MONITORING_RANGES.slice(1)) {
      await loadVmMonitoring({ projectId: 'project-b', instanceId: 'vm-b', range });
    }
    assert.deepEqual(calls.map(({ url }) => url), [
      '/api/servers/vm-a/monitoring?range=1h',
      '/api/servers/vm-b/monitoring?range=6h',
      '/api/servers/vm-b/monitoring?range=24h',
      '/api/servers/vm-b/monitoring?range=7d',
    ]);
    assert.equal(calls[0].options.signal, signal);
    assert.ok(calls.every(({ url, options }) => !url.includes('project_id') && !Object.hasOwn(options.headers, 'X-API-Key')));
  } finally { globalThis.fetch = oldFetch; }
  assert.notEqual(monitoringScopeKey('project-a', 'vm-a', '1h'), monitoringScopeKey('project-b', 'vm-a', '1h'));
  assert.notEqual(monitoringScopeKey('project-a', 'vm-a', '1h'), monitoringScopeKey('project-a', 'vm-b', '1h'));
  assert.notEqual(monitoringScopeKey('project-a', 'vm-a', '1h'), monitoringScopeKey('project-a', 'vm-a', '24h'));
});

test('formatters preserve real zero separately from unavailable values', () => {
  assert.equal(formatPercent(null), 'N/A');
  assert.equal(formatPercent(undefined), 'N/A');
  assert.equal(formatPercent(Number.NaN), 'N/A');
  assert.equal(formatPercent(0), '0%');
  assert.equal(formatPercent(37.2), '37.2%');
  assert.equal(formatBytesPerSecond(null), 'N/A');
  assert.equal(formatBytesPerSecond(0), '0 B/s');
  assert.equal(formatBytesPerSecond(1024), '1 KB/s');
});

test('VM Detail exposes Monitoring only when enabled, in the requested order', async () => {
  const vite = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' });
  try {
    const { detailTabs } = await vite.ssrLoadModule('/src/pages/InstanceDetail.jsx');
    assert.deepEqual(detailTabs(true), ['overview', 'networking', 'storage', 'security', 'monitoring', 'activity']);
    assert.deepEqual(detailTabs(false), ['overview', 'networking', 'storage', 'security', 'activity']);
    const detail = source('../src/pages/InstanceDetail.jsx');
    assert.match(detail, /React\.lazy\(\(\) => import\('\.\.\/components\/VmMonitoringTab\.jsx'\)\)/);
    assert.match(detail, /tab === 'monitoring'\) return/);
    assert.match(detail, /key=\{`\$\{instanceId\}:\$\{currentProjectId\}`\}/);
  } finally { await vite.close(); }
});

test('Monitoring renders five N/A summaries and four localized no-data charts', async () => {
  const vite = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' });
  const priorStorage = globalThis.localStorage;
  try {
    const { MonitoringView } = await vite.ssrLoadModule('/src/components/VmMonitoringTab.jsx');
    const { LocaleProvider } = await vite.ssrLoadModule('/src/i18n/react.jsx');
    for (const locale of ['en', 'vi']) {
      globalThis.localStorage = { getItem: () => locale };
      const html = renderToStaticMarkup(React.createElement(LocaleProvider, null,
        React.createElement(MonitoringView, { status: 'ready', data: emptyVmMonitoring(), range: '1h',
          onRangeChange() {}, onRefresh() {} })));
      assert.equal((html.match(/class="monitoring-summary-card"/g) || []).length, 5);
      assert.equal((html.match(/class="monitoring-chart-empty"/g) || []).length, 4);
      assert.ok((html.match(/N\/A/g) || []).length >= 7);
      assert.ok(html.includes(translate(locale, 'monitoring.noData')));
      assert.ok(html.includes(translate(locale, 'monitoring.chartEmpty')));
      assert.doesNotMatch(html, /<polyline/);
    }
  } finally {
    if (priorStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = priorStorage;
    await vite.close();
  }
});

test('loading and error are distinct from the no-data state', async () => {
  const vite = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' });
  const priorStorage = globalThis.localStorage;
  try {
    const { MonitoringView } = await vite.ssrLoadModule('/src/components/VmMonitoringTab.jsx');
    const { LocaleProvider } = await vite.ssrLoadModule('/src/i18n/react.jsx');
    globalThis.localStorage = { getItem: () => 'en' };
    const render = (status) => renderToStaticMarkup(React.createElement(LocaleProvider, null,
      React.createElement(MonitoringView, { status, data: null, range: '1h',
        onRangeChange() {}, onRefresh() {} })));
    const loading = render('loading');
    assert.match(loading, /Loading monitoring data/);
    assert.doesNotMatch(loading, /monitoring-summary-card|No monitoring data is available/);
    const error = render('error');
    assert.match(error, /Unable to load monitoring data/);
    assert.match(error, /Retry/);
    assert.doesNotMatch(error, /monitoring-summary-card|No monitoring data is available/);
    const unavailable = renderToStaticMarkup(React.createElement(LocaleProvider, null,
      React.createElement(MonitoringView, { status: 'error', error: { code: 'monitoring_unavailable' }, data: null,
        range: '1h', onRangeChange() {}, onRefresh() {} })));
    assert.match(unavailable, /Monitoring service is currently unavailable/);
  } finally {
    if (priorStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = priorStorage;
    await vite.close();
  }
});

test('range and refresh controls update the selected range and refresh callback', async () => {
  const vite = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' });
  try {
    const { TimeRangeSelector, MonitoringToolbar } = await vite.ssrLoadModule('/src/components/VmMonitoringTab.jsx');
    const t = (key) => translate('en', key);
    const selected = [];
    assert.deepEqual(MONITORING_RANGES, ['1h', '6h', '24h', '7d']);
    const selector = TimeRangeSelector({ range: '1h', onChange: (range) => selected.push(range), t });
    const buttons = React.Children.toArray(selector.props.children);
    assert.equal(buttons[0].props['aria-pressed'], true);
    for (const index of [1, 2, 3]) buttons[index].props.onClick();
    assert.deepEqual(selected, ['6h', '24h', '7d']);
    assert.equal(React.Children.toArray(TimeRangeSelector({ range: '24h', onChange() {}, t }).props.children)[2].props['aria-pressed'], true);
    let refreshed = 0;
    const toolbar = MonitoringToolbar({ range: '1h', onRangeChange() {}, onRefresh: () => refreshed++, status: 'ready', t });
    const actions = React.Children.toArray(toolbar.props.children)[1];
    const refresh = React.Children.toArray(actions.props.children)[1];
    refresh.props.onClick();
    assert.equal(refreshed, 1);
  } finally { await vite.close(); }
});

test('future normalized points render without fabricating missing sections, and long series are bounded', async () => {
  const vite = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' });
  const priorStorage = globalThis.localStorage;
  try {
    const { MonitoringView } = await vite.ssrLoadModule('/src/components/VmMonitoringTab.jsx');
    const { LocaleProvider } = await vite.ssrLoadModule('/src/i18n/react.jsx');
    globalThis.localStorage = { getItem: () => 'en' };
    const data = emptyVmMonitoring();
    data.summary.cpuPercent = 0;
    data.summary.networkRxBps = 0;
    data.summary.reachable = false;
    data.series.cpuPercent = [{ timestamp: 1760000000000, value: 0 }, { timestamp: 1760000060000, value: 37.2 }];
    data.series.networkRxBps = [{ timestamp: 1760000000000, value: 0 }, { timestamp: 1760000060000, value: 1024 }];
    assert.equal(hasMonitoringData(data), true);
    const html = renderToStaticMarkup(React.createElement(LocaleProvider, null,
      React.createElement(MonitoringView, { status: 'ready', data, range: '1h', onRangeChange() {}, onRefresh() {} })));
    assert.match(html, />0%<|>0%<!-- -->/);
    assert.match(html, /0 B\/s/);
    assert.match(html, /Unreachable/);
    assert.equal((html.match(/<polyline/g) || []).length, 2);
    assert.equal((html.match(/class="monitoring-chart-empty"/g) || []).length, 2);
    data.summary.reachable = 'unknown';
    const unknownHtml = renderToStaticMarkup(React.createElement(LocaleProvider, null,
      React.createElement(MonitoringView, { status: 'ready', data, range: '1h', onRangeChange() {}, onRefresh() {} })));
    assert.match(unknownHtml, /Unknown/);
    data.series.cpuPercent = [
      { timestamp: 1760000000000, value: 0 }, { timestamp: 1760000060000, value: 37.2 },
      { timestamp: 1760000120000, value: null },
      { timestamp: 1760000180000, value: 20 }, { timestamp: 1760000240000, value: 21 },
    ];
    const withGap = renderToStaticMarkup(React.createElement(LocaleProvider, null,
      React.createElement(MonitoringView, { status: 'ready', data, range: '1h', onRangeChange() {}, onRefresh() {} })));
    assert.equal((withGap.match(/<polyline/g) || []).length, 3, 'null history sample must split the CPU line');
    data.historyUnsupported = true;
    assert.match(renderToStaticMarkup(React.createElement(LocaleProvider, null,
      React.createElement(MonitoringView, { status: 'ready', data, range: '7d', onRangeChange() {}, onRefresh() {} }))),
    /Seven-day history is not available/);
    const long = Array.from({ length: 10_080 }, (_unused, index) => ({ timestamp: index * 60_000, value: index % 100 }));
    const sampled = chartPoints(long);
    assert.ok(sampled.length <= 600);
    assert.equal(sampled[0], long[0]);
    assert.equal(sampled.at(-1), long.at(-1));
  } finally {
    if (priorStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = priorStorage;
    await vite.close();
  }
});

test('browser boundary does not expose admin Monitoring API, PromQL, or credentials', () => {
  const code = [
    source('../src/monitoring/provider.js'), source('../src/monitoring/useVmMonitoring.js'),
    source('../src/components/VmMonitoringTab.jsx'),
  ].join('\n');
  assert.doesNotMatch(code, /X-API-Key|api\/v1\/|100\.64\.64\.181|9090|3000|MONITORING_API_KEY/);
  assert.match(code, /api\(`\/servers\/\$\{encodeURIComponent\(instanceId\)\}\/monitoring/);
  assert.doesNotMatch(source('../src/pages/Instances.jsx'), /VmMonitoringTab|loadVmMonitoring/);
  const css = source('../src/styles.css');
  assert.match(css, /\.monitoring-summary-grid \{ display: grid; grid-template-columns: repeat\(5, minmax\(0, 1fr\)\)/);
  assert.match(css, /@media \(max-width: 420px\) \{ \.monitoring-summary-grid \{ grid-template-columns: 1fr/);
});
