import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { formatActivity } from '../src/activityFormatter.js';
import { translate } from '../src/i18n/index.js';

const formatter = (locale) => (key, vars) => translate(locale, key, vars);

test('semantic CMP events use the same localized action formatter in both Activity views', () => {
  const codes = ['create', 'rename', 'start', 'stop', 'reboot.soft', 'reboot.hard',
    'resize.request', 'resize.confirm', 'resize.revert', 'password.change',
    'interface.attach', 'interface.detach', 'security_groups.change',
    'floating_ip.associate', 'floating_ip.disassociate', 'volume.attach',
    'volume.detach', 'snapshot.create', 'rebuild', 'shelve', 'unshelve', 'delete'];
  for (const locale of ['en', 'vi']) {
    for (const code of codes) {
      const event = formatActivity({ action: `instance.${code}`, result: 'accepted' }, formatter(locale));
      assert.equal(event.semantic, true);
      assert.notEqual(event.action, `instance.${code}`);
      assert.notEqual(event.result, 'accepted');
    }
  }
  const detailSource = readFileSync(fileURLToPath(new URL('../src/pages/InstanceDetail.jsx', import.meta.url)), 'utf8');
  const globalSource = readFileSync(fileURLToPath(new URL('../src/pages/AuditLog.jsx', import.meta.url)), 'utf8');
  assert.match(detailSource, /formatActivity\(event, t\)/);
  assert.match(globalSource, /formatActivity\(e, t\)/);
});

test('structured details render safely without showing unknown secret fields', () => {
  const t = formatter('en');
  assert.equal(formatActivity({ action: 'instance.rename', details: {
    old_name: 'Ubuntu', new_name: 'Ubuntu-Production', password: 'SECRET',
  } }, t).details, 'Ubuntu → Ubuntu-Production');
  assert.equal(formatActivity({ action: 'instance.resize.request', details: {
    old_flavor: '4C4G', new_flavor: '8C8G', token: 'SECRET',
  } }, t).details, '4C4G → 8C8G');
  assert.equal(formatActivity({ action: 'instance.interface.attach', details: {
    network_name: 'APP-NET', ip_address: '172.20.10.20', port_id: 'port-1', secret: 'SECRET',
  } }, t).details, 'APP-NET · 172.20.10.20 · port-1');
  assert.equal(formatActivity({ action: 'instance.security_groups.change', details: {
    added: ['web'], removed: ['default'], password: 'SECRET',
  } }, t).details, 'Added: web · Removed: default');
});

test('legacy generic actions remain representable without guessing history', () => {
  const t = formatter('en');
  assert.equal(formatActivity({ action: 'instance.action' }, t).action, 'Instance action');
  assert.equal(formatActivity({ action: 'post.servers', path: '/servers/vm-1/action' }, t).action, 'Instance action');
  assert.equal(formatActivity({ action: 'instance.unknown' }, t).action, 'instance.unknown');
});
