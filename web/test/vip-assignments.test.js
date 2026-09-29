import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { filterVipAssignmentVms, toggleVipPort, vipAssignmentVms } from '../src/vipAssignments.js';
import { translate } from '../src/i18n/index.js';

const subnetId = 'subnet-a';
const target = (name, instanceId, portId, ip, assigned = false) => ({
  id: portId, device_id: instanceId, instance_name: name,
  fixed_ips: [{ subnet_id: subnetId, ip_address: ip }], assigned,
});

async function withChoices(run) {
  const vite = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' });
  try {
    const { VipAssignmentChoices } = await vite.ssrLoadModule('/src/components/VipModals.jsx');
    const render = (vms, selected = new Set()) => renderToStaticMarkup(React.createElement(VipAssignmentChoices,
      { vms, selected, onToggle() {} }));
    await run(render);
  } finally { await vite.close(); }
}

test('a normal VM renders one named row with its subnet IP, never instance or Port UUID', async () => {
  const instanceId = '1de7836e-8540-4fe4-ad70-e1c400000001';
  const portId = '8f234ca1-8540-4fe4-ad70-e1c400000002';
  const vms = vipAssignmentVms([target('FW-01', instanceId, portId, '10.20.31.10', true)], subnetId);
  assert.equal(vms.length, 1);
  assert.equal(vms[0].interfaces[0].portId, portId);
  await withChoices((render) => {
    const html = render(vms, new Set([portId]));
    assert.match(html, /FW-01/);
    assert.match(html, /10\.20\.31\.10/);
    assert.match(html, /checked=""/);
    assert.equal((html.match(/type="checkbox"/g) || []).length, 1);
    assert.doesNotMatch(html, new RegExp(`${instanceId}|${portId}`));
  });
});

test('many VMs remain one row each and long names wrap inside a vertically scrolling picker', async () => {
  const longName = `FW-${'production-'.repeat(12)}`;
  const targets = Array.from({ length: 35 }, (_, index) => target(
    index === 0 ? longName : `FW-${String(index).padStart(2, '0')}`,
    `instance-${index}`, `port-${index}`, `10.20.31.${index + 10}`));
  const vms = vipAssignmentVms(targets, subnetId);
  await withChoices((render) => {
    const html = render(vms);
    assert.equal((html.match(/class="vip-vm-choice vip-vm-choice-single"/g) || []).length, 35);
    assert.match(html, new RegExp(longName));
    assert.doesNotMatch(html, /instance-0|port-0/);
  });
  const css = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8');
  assert.match(css, /\.vip-assignment-list \{[^}]*max-height:[^}]*overflow-y: auto;[^}]*overflow-x: hidden;/);
  assert.match(css, /\.vip-vm-identity strong, \.vip-vm-name \{ overflow-wrap: anywhere; \}/);
  assert.match(css, /\.vip-assignments-modal \.modal-body \{[^}]*overflow-x: hidden;/);
});

test('two eligible Ports on one VM render one VM group with distinct interface choices', async () => {
  const targets = [target('FW-01', 'instance-one', 'port-a', '10.20.31.10', true),
    target('FW-01', 'instance-one', 'port-b', '10.20.31.11', true),
    target('APP-01', 'instance-two', 'port-c', '10.20.31.20')];
  const vms = vipAssignmentVms(targets, subnetId);
  assert.equal(vms.length, 2);
  assert.deepEqual(vms.find((vm) => vm.instanceName === 'FW-01').interfaces.map((item) => item.portId), ['port-a', 'port-b']);
  await withChoices((render) => {
    const html = render(vms, new Set(['port-a', 'port-b']));
    assert.equal((html.match(/FW-01/g) || []).length, 1);
    assert.match(html, /10\.20\.31\.10/);
    assert.match(html, /10\.20\.31\.11/);
    assert.equal((html.match(/checked=""/g) || []).length, 2);
    assert.doesNotMatch(html, /port-a|port-b|instance-one/);
  });
  const chosen = toggleVipPort(new Set(['port-a', 'port-b']), 'port-a');
  chosen.add('port-c');
  assert.deepEqual([...chosen].sort(), ['port-b', 'port-c']);
});

test('search uses VM name or fixed IP, not UUID; empty and locale messages are present', async () => {
  const vms = vipAssignmentVms([target('FW-02', 'instance-secret', 'port-secret', '10.20.31.11'),
    target('FW-01', 'instance-other', 'port-other', '10.20.31.10')], subnetId);
  assert.deepEqual(vms.map((vm) => vm.instanceName), ['FW-01', 'FW-02']);
  assert.deepEqual(filterVipAssignmentVms(vms, 'FW-02').map((vm) => vm.instanceName), ['FW-02']);
  assert.deepEqual(filterVipAssignmentVms(vms, '31.10').map((vm) => vm.instanceName), ['FW-01']);
  assert.deepEqual(filterVipAssignmentVms(vms, 'instance-secret'), []);
  await withChoices((render) => {
    assert.match(render([]), /Không có máy ảo phù hợp trong subnet này/);
  });
  for (const locale of ['vi', 'en']) {
    for (const key of ['title', 'vip', 'selectInstances', 'search', 'interface', 'noEligibleInstances',
      'noSearchResults', 'loading', 'loadError', 'save']) {
      assert.notEqual(translate(locale, `vip.assignments.${key}`), `vip.assignments.${key}`);
    }
  }
  const source = readFileSync(fileURLToPath(new URL('../src/components/VipModals.jsx', import.meta.url)), 'utf8');
  assert.match(source, /body: \{ port_ids: \[\.\.\.selected\] \}/);
  assert.match(source, /setSelected\(new Set\(result\.targets\.filter\(\(target\) => target\.assigned\)/);
});
