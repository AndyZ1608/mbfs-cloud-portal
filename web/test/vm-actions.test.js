import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { vmActionItems } from '../src/vmActions.js';
import { translate } from '../src/i18n/index.js';

const keys = [
  'console', 'changePassword', 'rename', 'networkCards', 'securityGroups', 'floatingIp', 'snapshot',
  'start', 'stop', 'softReboot', 'hardReboot', 'resize', 'confirmResize', 'revertResize',
  'shelve', 'unshelve', 'rebuild', 'delete',
];
const handlers = Object.fromEntries(keys.map((key) => [key, () => key]));
const itemsFor = (status, locale = 'en', pendingResize = false, taskState = null) => vmActionItems(
  { status, 'OS-EXT-STS:task_state': taskState },
  { t: (key) => translate(locale, key), pendingResize, handlers },
);
const order = (items) => items.map((item) => item === 'divider' ? 'divider' : item.key);

test('ACTIVE VM menu has the requested order, two separators, and no monitoring or console log', () => {
  const items = itemsFor('ACTIVE');
  assert.deepEqual(order(items), [
    'console', 'changePassword', 'rename', 'networkCards', 'securityGroups', 'floatingIp', 'snapshot',
    'divider', 'stop', 'softReboot', 'hardReboot', 'resize', 'shelve', 'rebuild', 'divider', 'delete',
  ]);
  assert.equal(items[0].label, 'Open Console');
  assert.equal(items.at(-1).label, 'Delete VM');
  assert.ok(!items.some((item) => item?.key === 'monitor' || item?.key === 'consoleLog'));
  assert.ok(items.filter((item) => item !== 'divider').every((item) => item.onClick === handlers[item.key]));
  for (const key of ['stop', 'softReboot', 'hardReboot', 'resize', 'shelve', 'rebuild']) {
    assert.equal(items.find((item) => item.key === key).tone, 'danger');
  }
  for (const key of ['console', 'changePassword', 'rename', 'networkCards', 'securityGroups', 'floatingIp', 'snapshot']) {
    assert.equal(items.find((item) => item.key === key).tone, undefined);
  }
  assert.equal(items.at(-1).tone, 'destructive');
});

test('existing VM-state and pending-resize availability stays unchanged', () => {
  assert.deepEqual(order(itemsFor('SHUTOFF')), [
    'console', 'changePassword', 'rename', 'networkCards', 'securityGroups', 'floatingIp', 'snapshot',
    'divider', 'start', 'resize', 'rebuild', 'divider', 'delete',
  ]);
  assert.deepEqual(order(itemsFor('SHELVED')).slice(-4), ['start', 'unshelve', 'divider', 'delete']);
  const verifying = itemsFor('VERIFY_RESIZE');
  assert.ok(order(verifying).includes('confirmResize'));
  assert.ok(order(verifying).includes('revertResize'));
  assert.ok(!order(verifying).includes('resize'));
  assert.equal(verifying.find((item) => item.key === 'confirmResize').tone, undefined);
  assert.equal(verifying.find((item) => item.key === 'revertResize').tone, 'danger');
  const pending = order(itemsFor('VERIFY_RESIZE', 'en', true));
  assert.ok(!pending.includes('confirmResize') && !pending.includes('revertResize'));
  assert.ok(!order(itemsFor('ACTIVE', 'en', false, 'spawning')).includes('resize'));
});

test('action labels remain localized and disabled danger styling is muted', () => {
  const vi = itemsFor('ACTIVE', 'vi');
  assert.equal(vi[0].label, 'Mở console');
  assert.equal(vi.find((item) => item.key === 'stop').label, 'Tắt máy');
  assert.equal(vi.at(-1).label, 'Xoá máy ảo');
  const css = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8');
  assert.match(css, /\.menu-item\.danger:hover:not\(:disabled\)\s*\{[^}]*var\(--err-bg\)/);
  assert.match(css, /\.menu-item\.danger:disabled, \.menu-item\.destructive:disabled\s*\{[^}]*var\(--dim\)/);
  assert.match(css, /\.menu-item\.destructive\s*\{[^}]*font-weight:\s*700/);
});
