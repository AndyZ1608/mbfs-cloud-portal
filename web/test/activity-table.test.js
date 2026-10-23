import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { activityStatus, activityTarget, activityTimestamp, vmActivityName } from '../src/activityPresentation.js';
import { translate } from '../src/i18n/index.js';

const vmId = '78b3f3ae-ec6d-470d-b607-46681cb3207c';
const t = (locale) => (key, vars) => translate(locale, key, vars);

test('timestamp uses local timezone and exact DD/MM/YYYY HH:mm:ss layout', () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = 'Asia/Ho_Chi_Minh';
    assert.equal(activityTimestamp('2026-10-05T08:21:53Z'), '05/10/2026 15:21:53');
    assert.equal(activityTimestamp('not-a-date'), '—');
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('historical VM names survive deletion; UUID-only and foreign IDs use neutral fallback', () => {
  const vi = t('vi');
  const deleted = { action: 'instance.delete', resource_type: 'instance', resource_id: vmId,
    resource_name: 'Windows-2022-khong-xoa' };
  assert.equal(vmActivityName(deleted, vi), 'Windows-2022-khong-xoa');
  assert.equal(vmActivityName({ ...deleted, resource_name: vmId }, vi), 'Không xác định');
  assert.equal(vmActivityName({ ...deleted, resource_name: null }, vi, { [vmId]: 'Current VM' }), 'Current VM');
  assert.equal(vmActivityName({ ...deleted, resource_name: null }, vi, { 'another-project-vm': 'Foreign VM' }), 'Không xác định');
  assert.equal(vmActivityName({ action: 'volume.attach', resource_type: 'volume', resource_name: 'Volume A' }, vi), '—');
  assert.equal(vmActivityName({ action: 'vip.assign', resource_type: 'vip', instance_id: vmId,
    resource_name: 'VIP reservation' }, vi, { [vmId]: 'Firewall VM' }), 'Firewall VM');
  assert.equal(vmActivityName({ action: 'instance.stop', resource_name: 'Ubuntu Production' }, vi), 'Ubuntu Production');
});

test('status badges preserve success, failure and accepted-request semantics', () => {
  const vi = t('vi');
  assert.deepEqual(activityStatus({ result: 'success', status: 200 }, vi), { label: 'Thành công', tone: 'ok' });
  assert.deepEqual(activityStatus({ result: 'failure', status: 500 }, vi), { label: 'Thất bại', tone: 'err' });
  assert.deepEqual(activityStatus({ result: 'success', status: 202 }, vi), { label: 'Đã tiếp nhận', tone: 'info' });
  assert.deepEqual(activityStatus({ result: 'accepted', status: 202 }, vi), { label: 'Đã tiếp nhận', tone: 'info' });
});

test('targets use structured resource names and safe historical fallbacks', () => {
  const vi = t('vi');
  assert.deepEqual(activityTarget({ resource_type: 'network', resource_name: 'NET_PROD' }, vi),
    { type: 'Network', name: 'NET_PROD' });
  assert.deepEqual(activityTarget({ resource_type: 'volume', resource_name: 'DATA-01', action: 'volume.delete' }, vi),
    { type: 'Volume', name: 'DATA-01' });
  assert.deepEqual(activityTarget({ resource_type: 'router', resource_name: 'ROUTER-PROD' }, vi),
    { type: 'Router', name: 'ROUTER-PROD' });
  assert.deepEqual(activityTarget({ resource_type: 'security_group', resource_name: 'SG-Web' }, vi),
    { type: 'Security Group', name: 'SG-Web' });
  assert.deepEqual(activityTarget({ resource_type: 'floating_ip', resource_name: '100.64.64.190' }, vi),
    { type: 'Floating IP', name: '100.64.64.190' });
  assert.deepEqual(activityTarget({ resource_type: 'snapshot', resource_name: 'daily-data' }, vi),
    { type: 'Snapshot', name: 'daily-data' });
  assert.deepEqual(activityTarget({ resource_type: 'project', resource_name: 'XPLAT' }, vi),
    { type: 'Project', name: 'XPLAT' });
  assert.deepEqual(activityTarget({ resource_type: 'user', resource_name: 'ducnn' }, vi),
    { type: 'User', name: 'ducnn' });
  assert.deepEqual(activityTarget({ action: 'auth.login', path: '/auth/login' }, vi),
    { type: 'CMP', name: 'Phiên đăng nhập' });
  assert.deepEqual(activityTarget({ resource_type: 'volume', resource_name: vmId }, vi),
    { type: 'Volume', name: 'Không xác định' });
  assert.deepEqual(activityTarget({ action: 'subnet.gateway.update', resource_type: 'network',
    resource_name: 'Network, not subnet' }, vi), { type: 'Subnet', name: 'Không xác định' });
});

test('shared table renders exactly five localized columns without technical audit metadata', async () => {
  const vite = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' });
  const previousStorage = globalThis.localStorage;
  const previousTz = process.env.TZ;
  try {
    process.env.TZ = 'Asia/Ho_Chi_Minh';
    const { default: ActivityTable } = await vite.ssrLoadModule('/src/components/ActivityTable.jsx');
    const { LocaleProvider } = await vite.ssrLoadModule('/src/i18n/react.jsx');
    const { actionLabel, filterActivityRows } = await vite.ssrLoadModule('/src/pages/AuditLog.jsx');
    const entry = { ts: '2026-10-05T08:21:53Z', user: 'ducnn', action: 'instance.console.open',
      resource_type: 'instance', resource_id: vmId, resource_name: 'Windows-2022-khong-xoa',
      project: { id: 'project-secret', name: 'XPLAT' }, path: `/servers/${vmId}/console`,
      status: 200, result: 'success', ms: 1205, request_id: 'internal-request',
      details: { secret: 'hidden-detail' } };
    function render(locale, event = entry) {
      globalThis.localStorage = { getItem: (key) => key === 'cmp.locale' ? locale : null };
      return renderToStaticMarkup(React.createElement(LocaleProvider, null,
        React.createElement(ActivityTable, { entries: Array.isArray(event) ? event : [event],
          actionFor: (item) => actionLabel(item, t(locale)) })));
    }
    const vi = render('vi');
    assert.equal((vi.match(/<th\b/g) || []).length, 5);
    assert.equal((vi.match(/<td\b/g) || []).length, 5);
    for (const text of ['Thời gian', 'Người dùng', 'Thao tác', 'Đối tượng', 'Trạng thái',
      '05/10/2026 15:21:53', 'ducnn', 'Mở Console', 'Windows-2022-khong-xoa', 'Thành công']) {
      assert.ok(vi.includes(text), text);
    }
    for (const hidden of [vmId, 'XPLAT', 'project-secret', '/servers/', '1205ms', 'internal-request',
      'hidden-detail', '>200<']) assert.ok(!vi.includes(hidden), hidden);
    assert.match(vi, /badge-ok/);
    const en = render('en');
    assert.match(en, /Target/);
    assert.match(en, /activity-target-type">VM/);
    assert.match(en, /Console opened/);
    assert.match(en, /Success/);
    const failed = render('vi', { ...entry, status: 500, result: 'failure' });
    assert.match(failed, /badge-err/);
    assert.match(failed, /Thất bại/);
    const accepted = render('en', { ...entry, status: 202, result: 'accepted' });
    assert.match(accepted, /badge-info/);
    assert.match(accepted, /Accepted/);
    assert.doesNotMatch(accepted, /Success/);
    const mixed = render('vi', [{ ...entry, resource_type: 'network', action: 'network.create',
      resource_name: 'NET_PROD' }, { ...entry, resource_type: 'volume', action: 'volume.delete',
      resource_name: 'DATA-01' }, { ...entry, action: 'auth.login', resource_type: 'cmp',
      path: '/auth/login', resource_name: null }]);
    assert.match(mixed, /Network<\/span><span class="activity-target-name">NET_PROD/);
    assert.match(mixed, /Volume<\/span><span class="activity-target-name">DATA-01/);
    assert.match(mixed, /CMP<\/span><span class="activity-target-name">Phiên đăng nhập/);
    const ordered = render('en', [{ ...entry, resource_name: 'Newest VM' },
      { ...entry, ts: '2026-10-04T08:21:53Z', resource_name: 'Older VM' }]);
    assert.ok(ordered.indexOf('Newest VM') < ordered.indexOf('Older VM'));
    const rows = [entry, { ...entry, ts: '2026-10-04T08:21:53Z', resource_name: 'Older VM' },
      { action: 'volume.attach', resource_type: 'volume', resource_name: 'Volume A', user: 'other' }];
    const vmRows = filterActivityRows(rows, { resourceFilter: 'instance', t: t('en') });
    assert.deepEqual(vmRows, rows.slice(0, 2), 'VM filter preserves newest-first input order');
    assert.deepEqual(filterActivityRows(rows, { query: 'Older VM', t: t('en') }), [rows[1]]);
    assert.deepEqual(filterActivityRows(rows, { query: vmId, t: t('en') }), [], 'hidden UUID is not a search/display field');
    assert.equal(filterActivityRows(rows, { t: t('en') }).length, 3);
    assert.equal(actionLabel({ method: 'GET', path: '/internal/secret' }, t('en')), 'Other action');
    assert.equal(actionLabel({ action: 'network.create', method: 'POST', path: '/networks' }, t('vi')), 'Tạo network');
    assert.equal(actionLabel({ action: 'network.rename', resource_type: 'network' }, t('en')), 'Network renamed');
    assert.equal(actionLabel({ action: 'volume.delete', method: 'DELETE', path: '/volumes/id' }, t('en')), 'Delete volume');
    assert.equal(actionLabel({ action: 'project.quota.update' }, t('vi')), 'Cập nhật quota Project');
  } finally {
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
    await vite.close();
  }
});

test('both Activity views share the table; filter, refresh and load-more paths remain', () => {
  const global = readFileSync(fileURLToPath(new URL('../src/pages/AuditLog.jsx', import.meta.url)), 'utf8');
  const detail = readFileSync(fileURLToPath(new URL('../src/pages/InstanceDetail.jsx', import.meta.url)), 'utf8');
  assert.match(global, /<ActivityTable entries=\{filtered\}/);
  assert.match(global, /resourceFilter === 'instance'/);
  assert.match(global, /onRefresh=\{load\}/);
  assert.match(global, /api\('\/audit\?limit=500'\)/);
  assert.match(global, /api\('\/servers'\)/);
  assert.doesNotMatch(global, /project_id=/);
  assert.match(detail, /<ActivityTable entries=\{tabData\?\.entries \|\| \[\]\}/);
  assert.match(detail, /tabData\?\.next_offset != null/);
  assert.match(detail, /onClick=\{loadMoreActivity\}/);
  assert.match(detail, /action !== event\.action \? action : t\('audit\.action\.other'\)/);
});
