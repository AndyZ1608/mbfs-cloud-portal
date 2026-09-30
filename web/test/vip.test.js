import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { formatActivity } from '../src/activityFormatter.js';
import { apiErrorMessage } from '../src/api.js';
import { translate } from '../src/i18n/index.js';

const source = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

test('Network detail is the primary Port/VIP route and legacy Subnet links redirect', () => {
  const app = source('../src/App.jsx');
  assert.match(app, /path="\/networks\/:networkId"/);
  assert.match(app, /path="\/networks\/:networkId\/subnets\/:subnetId"/);
  assert.match(source('../src/pages/Networks.jsx'), /to=\{`\/networks\/\$\{encodeURIComponent\(n.id\)\}`\}/);
  assert.match(app, /<LegacySubnetRedirect \/>/);
  assert.doesNotMatch(source('../src/pages/Networks.jsx'), /to=\{`\/networks\/\$\{encodeURIComponent\(n.id\)\}\/subnets\//);
  const detail = source('../src/pages/NetworkDetail.jsx');
  assert.match(detail, /key=\{`\$\{sess.project.id\}:\$\{networkId\}`\}/);
  assert.match(detail, /\/resources`\)/);
  assert.match(detail, /subnetState === 'none'/);
  assert.match(detail, /subnetState === 'multiple'/);
  assert.match(detail, /subnetState === 'single'/);
});

test('VIP creation offers optional subnet-aware IP and assignment editors submit IDs only', async () => {
  const vite = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' });
  try {
    const { CreateVipModal } = await vite.ssrLoadModule('/src/components/VipModals.jsx');
    const html = renderToStaticMarkup(React.createElement(CreateVipModal, {
      subnet: { id: 'subnet-a', name: 'App', cidr: '10.20.31.0/24', gateway_ip: '10.20.31.1' },
      onClose() {}, onDone() {},
    }));
    assert.match(html, /Địa chỉ VIP/);
    assert.match(html, /aria-required="false"/);
    assert.match(html, /10\.20\.31\./);
    assert.match(html, /disabled=""[^>]*>Tạo Virtual IP/);
    const modals = source('../src/components/VipModals.jsx');
    assert.match(modals, /body: \{ port_ids: \[\.\.\.selected\] \}/);
    assert.match(modals, /body: \{ vip_port_ids: \[\.\.\.selected\] \}/);
    assert.match(modals, /data\.external_pairs\.map/);
    assert.doesNotMatch(modals, /allowed_address_pairs:|port_security_enabled:|security_groups:/);
  } finally { await vite.close(); }
});

test('Network Port/VIP classification, VM AAP view and assigned-delete guard are wired', async () => {
  const vite = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' });
  try {
    const { portType } = await vite.ssrLoadModule('/src/pages/NetworkDetail.jsx');
    assert.equal(portType({ cmp_vip: true, device_owner: '' }), 'vip');
    assert.equal(portType({ device_owner: 'compute:nova' }), 'vm');
    assert.equal(portType({ device_owner: 'network:router_interface' }), 'router');
    assert.equal(portType({ device_owner: 'network:dhcp' }), 'dhcp');
    const network = source('../src/pages/NetworkDetail.jsx');
    assert.match(network, /vip\.assignment_count > 0/);
    assert.match(network, /subnet\.port\.type\.\$\{portType\(port\)\}/);
    assert.match(network, /<AttachVipModal/);
    const detail = source('../src/pages/InstanceDetail.jsx');
    assert.match(detail, /api\(`\/servers\/\$\{encodedId\}\/vips`\)/);
    assert.match(detail, /<PortVipsModal/);
    assert.match(detail, /port\.vipView\.external_pairs\.map/);
  } finally { await vite.close(); }
});

test('VIP UI and semantic activity labels translate in both languages and suppress unknown details', () => {
  for (const locale of ['en', 'vi']) {
    for (const key of ['vip.create', 'vip.manageAssignments', 'vip.attachToVm', 'vip.reserved', 'vip.deleteConfirm',
      'network.detail.noSubnetTitle', 'network.detail.multipleSubnets',
      'subnet.detail.virtualIps', 'subnet.port.allowedPairs', 'instance.networking.manageVips',
      'instance.networking.externalAddressPair', 'errors.vip_delete_assigned']) {
      assert.notEqual(translate(locale, key), key, `${locale}: ${key}`);
    }
    const event = formatActivity({ action: 'vip.assign', result: 'success', details: {
      vip_name: 'APP-VIP', vip_ip: '10.20.31.100', fixed_ip: '10.20.31.10', token: 'SECRET',
    } }, (key, vars) => translate(locale, key, vars));
    assert.equal(event.semantic, true);
    assert.notEqual(event.action, 'vip.assign');
    assert.equal(event.details, 'APP-VIP · 10.20.31.100 · 10.20.31.10');
    assert.ok(!event.details.includes('SECRET'));
  }
  assert.match(apiErrorMessage({ code: 'vip_partial_failure', changed: 2, failedPortId: 'port-c' }, 409), /2.*port-c/);
});
