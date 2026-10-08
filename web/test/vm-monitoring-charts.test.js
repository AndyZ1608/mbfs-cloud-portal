import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chartSamples, chartTimeTicks, formatAxisTimestamp, formatChartValue,
  formatFullTimestamp, hoverTimestampAt, nearestRecordedTimestamp, recordedTimestamps, recordedValuesAt,
  sampleTolerance } from '../src/monitoring/chart.js';

const START = Date.UTC(2026, 9, 8, 9, 20, 30);
const source = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

test('full tooltip timestamp uses normalized JavaScript milliseconds and the local timezone', () => {
  const expected = new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date(START));
  assert.equal(formatFullTimestamp(START, 'en-US'), expected);
  assert.match(expected, /October 8, 2026/);
  assert.match(expected, /:20:30/);
  assert.notEqual(formatFullTimestamp(START / 1000, 'en-US'), expected, 'do not double-convert API seconds in the chart');
  assert.match(source('../../server/monitoring/service.js'), /timestamp: point\[0\] \* 1000/,
    'the CMP backend already converts Monitoring Unix seconds to milliseconds');
});

test('axis ticks adapt to range and available width with local-time labels', () => {
  const ranges = [
    ['1h', 3_600_000], ['6h', 6 * 3_600_000], ['24h', 24 * 3_600_000], ['7d', 7 * 24 * 3_600_000],
  ];
  for (const [range, duration] of ranges) {
    const wide = chartTimeTicks(START, START + duration, range, 600);
    const narrow = chartTimeTicks(START, START + duration, range, 240);
    assert.ok(wide.length >= narrow.length);
    assert.ok(narrow.length >= 2);
    assert.ok(wide.every((timestamp) => timestamp >= START && timestamp <= START + duration));
    assert.ok(wide.every((timestamp, index) => index === 0 || timestamp > wide[index - 1]));
  }
  assert.match(formatAxisTimestamp(START, '1h', 'en-US'), /:/);
  assert.match(formatAxisTimestamp(START, '6h', 'en-US'), /:/);
  assert.match(formatAxisTimestamp(START, '24h', 'en-US'), /Oct/);
  assert.match(formatAxisTimestamp(START, '7d', 'en-US'), /Oct/);
  assert.notEqual(formatAxisTimestamp(START, '1h', 'en-US'), formatAxisTimestamp(START, '24h', 'en-US'));
  assert.equal(chartTimeTicks(START, START + 24 * 3_600_000, '24h', 140).length, 1,
    'narrow charts reduce date labels rather than overlap');
});

test('nearest hover selection uses recorded points only, with null gaps and real zero preserved', () => {
  const rx = chartSamples([
    { timestamp: START + 120_000, value: 1024 },
    { timestamp: START, value: 0 },
    { timestamp: START + 60_000, value: 0 },
  ]);
  const tx = chartSamples([
    { timestamp: START + 121_000, value: 1_800_000 },
    { timestamp: START + 1_000, value: 4096 },
    { timestamp: START + 61_000, value: null },
  ]);
  assert.deepEqual(chartSamples([{ timestamp: START, value: 1 },
    { timestamp: START + 30_000 }, { timestamp: START + 60_000, value: 2 }])
    .map((point) => point.value), [1, null, 2], 'absent values remain visible gaps');
  const lines = [
    { key: 'rx', label: 'RX', color: 'red', samples: rx, toleranceMs: sampleTolerance(rx) },
    { key: 'tx', label: 'TX', color: 'blue', samples: tx, toleranceMs: sampleTolerance(tx) },
  ];
  const times = recordedTimestamps(lines);
  assert.ok(times.includes(START));
  assert.equal(nearestRecordedTimestamp(times, START + 5_000), START + 1_000);
  assert.equal(nearestRecordedTimestamp(times, START + 91_000), START + 120_000);
  const geometry = { left: 100, width: 600, viewWidth: 600, plotLeft: 64, plotRight: 588 };
  assert.equal(hoverTimestampAt(times, 100 + 64, geometry), START);
  assert.equal(hoverTimestampAt(times, 100 + 588, geometry), START + 121_000);
  assert.equal(hoverTimestampAt(times, 100 + 30, geometry), null);
  const zero = recordedValuesAt(lines, START + 60_000);
  assert.deepEqual(zero.map(({ key, point }) => [key, point.value]), [['rx', 0]],
    'TX null must not be replaced by a neighboring sample or zero');
  const both = recordedValuesAt(lines, START + 120_000);
  assert.deepEqual(both.map(({ key, point }) => [key, point.value]), [['rx', 1024], ['tx', 1_800_000]]);
  assert.equal(both[1].point.timestamp, START + 121_000, 'each value keeps its actual recorded timestamp');
  assert.deepEqual(recordedValuesAt([{ ...lines[0], samples: [] }], START), []);
});

test('tooltips show exact time, colored multiple-series values, and metric-specific units', async () => {
  const vite = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' });
  try {
    const { ChartTooltip } = await vite.ssrLoadModule('/src/components/VmMonitoringTab.jsx');
    const values = [
      { key: 'read', label: 'Read', color: 'red', point: { timestamp: START, value: 1_800_000 } },
      { key: 'write', label: 'Write', color: 'blue', point: { timestamp: START + 1_000, value: 650 * 1024 } },
    ];
    const html = renderToStaticMarkup(React.createElement(ChartTooltip, {
      timestamp: START, selected: values, unit: 'throughput', range: '1h', locale: 'en-US', left: 40,
    }));
    assert.match(html, /October 8, 2026/);
    assert.match(html, /:20:30/);
    assert.match(html, /Read/);
    assert.match(html, /Write/);
    assert.match(html, /1\.7 MB\/s/);
    assert.match(html, /650 KB\/s/);
    assert.match(html, /:20:31/, 'offset series retains its own recorded second');
    assert.match(html, /background:red/);
    assert.match(html, /background:blue/);
    const cpu = renderToStaticMarkup(React.createElement(ChartTooltip, {
      timestamp: START, selected: [{ key: 'cpu', label: 'CPU Usage', color: 'red',
        point: { timestamp: START, value: 42.7 } }], unit: 'percent', range: '1h', locale: 'en-US', left: 40,
    }));
    assert.match(cpu, /CPU Usage/);
    assert.match(cpu, /42\.7%/);
    assert.doesNotMatch(cpu, /B\/s/);
    assert.equal(formatChartValue(0, 'percent'), '0%');
    assert.equal(formatChartValue(0, 'throughput'), '0 B/s');
    assert.equal(formatChartValue(null, 'throughput'), 'N/A');
  } finally { await vite.close(); }
});

test('all four chart types render axes and empty charts remain safe without requests', async () => {
  const vite = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('hover/chart rendering must not request the backend'); };
  try {
    const { MetricChart } = await vite.ssrLoadModule('/src/components/VmMonitoringTab.jsx');
    const t = () => 'No data';
    const types = [
      ['CPU Usage', 'percent', ['CPU']], ['Memory Usage', 'percent', ['Memory']],
      ['Disk I/O', 'throughput', ['Read', 'Write']], ['Network Traffic', 'throughput', ['RX', 'TX']],
    ];
    for (const [title, unit, labels] of types) {
      const series = labels.map((label, index) => ({ key: label, label, color: index ? 'blue' : 'red',
        points: [{ timestamp: START, value: 0 }, { timestamp: START + 60_000, value: unit === 'percent' ? 42.7 : 1024 }] }));
      const html = renderToStaticMarkup(React.createElement(MetricChart, {
        title, series, unit, range: '1h', locale: 'en-US', t,
      }));
      assert.match(html, /monitoring-chart-axis/);
      assert.match(html, /tabindex="0"/);
      assert.match(html, unit === 'percent' ? /100%/ : /KB\/s/);
      assert.doesNotMatch(html, /monitoring-chart-empty/);
      const empty = renderToStaticMarkup(React.createElement(MetricChart, {
        title, series: series.map((line) => ({ ...line, points: [] })), unit, range: '1h', locale: 'en-US', t,
      }));
      assert.match(empty, /monitoring-chart-empty/);
    }
  } finally {
    globalThis.fetch = originalFetch;
    await vite.close();
  }
});
