import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { translate } from '../src/i18n/index.js';

const data = {
  network: { id: 'net-1', name: 'APP-NET', revision_number: 3 },
  routers: [{ id: 'router-a', name: 'XPLAT-Router' }, { id: 'router-b', name: 'Backup Router' }],
  subnets: [
    { id: 'sub-1', name: 'APP-SUBNET', cidr: '172.20.10.0/24', ip_version: 4, revision_number: 2,
      gateway_ip: '172.20.10.1', dns_nameservers: ['8.8.8.8'], allocation_pools: [{ start: '172.20.10.100', end: '172.20.10.200' }],
      enable_dhcp: true, mode: 'routed', router_id: 'router-a' },
    { id: 'sub-2', name: 'LEGACY-SUBNET', cidr: '172.20.11.0/24', ip_version: 4,
      gateway_ip: '172.20.11.1', dns_nameservers: [], allocation_pools: [],
      enable_dhcp: false, mode: 'isolated', router_id: null },
  ],
};

test('network action menu offers normal Edit before destructive Delete, never for shared/external', async () => {
  const vite = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' });
  try {
    const { networkActionItems } = await vite.ssrLoadModule('/src/pages/Networks.jsx');
    const items = networkActionItems({ id: 'net-1' }, () => {}, () => {}, (key) => translate('en', key));
    assert.deepEqual(items.map((item) => typeof item === 'string' ? item : item.label), ['Edit Network', 'divider', 'Delete Network']);
    assert.equal(items[0].danger, undefined);
    assert.equal(items[2].danger, true);
    assert.deepEqual(networkActionItems({ shared: true }, () => {}, () => {}, (key) => key).map((item) => item.label), ['networks.deleteNetwork']);
    assert.deepEqual(networkActionItems({ 'router:external': true }, () => {}, () => {}, (key) => key), []);
  } finally { await vite.close(); }
});

test('form preserves subnet identities and DHCP state while submitting only editable fields', async () => {
  const vite = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' });
  try {
    const { editFormFrom, editBodyFrom, isNetworkEditDirty } = await vite.ssrLoadModule('/src/components/NetworkEditModal.jsx');
    const form = editFormFrom(data);
    assert.equal(isNetworkEditDirty(form, data), false);
    form.subnets[0].dns = '1.1.1.1\n8.8.8.8';
    form.subnets[1].mode = 'routed'; form.subnets[1].router_id = 'router-b';
    assert.equal(isNetworkEditDirty(form, data), true);
    const body = editBodyFrom(form);
    assert.deepEqual(body.subnets[0].dns_nameservers, ['1.1.1.1', '8.8.8.8']);
    assert.deepEqual(body.subnets[0].allocation_pools, [{ start: '172.20.10.100', end: '172.20.10.200' }]);
    assert.equal(body.subnets[1].id, 'sub-2');
    assert.equal(body.subnets[1].router_id, 'router-b');
    for (const subnet of body.subnets) {
      assert.equal('cidr' in subnet, false);
      assert.equal('ip_version' in subnet, false);
      assert.equal('enable_dhcp' in subnet, false);
      assert.equal('project_id' in subnet, false);
    }
  } finally { await vite.close(); }
});

test('edit form renders both subnets, read-only CIDR/DHCP, editable metadata, routing warning, and vi/en text', async () => {
  const vite = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' });
  const priorStorage = globalThis.localStorage;
  try {
    const { NetworkEditForm, editFormFrom } = await vite.ssrLoadModule('/src/components/NetworkEditModal.jsx');
    const { LocaleProvider } = await vite.ssrLoadModule('/src/i18n/react.jsx');
    const form = editFormFrom(data);
    form.subnets[0].mode = 'isolated'; form.subnets[0].router_id = '';
    form.subnets[0].gateway_ip = '172.20.10.254';
    const render = (locale) => {
      globalThis.localStorage = { getItem: (key) => key === 'cmp.locale' ? locale : null };
      return renderToStaticMarkup(React.createElement(LocaleProvider, null,
        React.createElement(NetworkEditForm, { original: data, form, routers: data.routers, busy: false, onForm: () => {} })));
    };
    const en = render('en');
    assert.match(en, /Edit|Network Name/);
    assert.match(en, /APP-SUBNET/);
    assert.match(en, /LEGACY-SUBNET/);
    assert.match(en, /172\.20\.10\.0\/24/);
    assert.match(en, /Disabled \(legacy\)/);
    assert.match(en, /detach this subnet from its Router/);
    assert.match(en, /Changing the gateway/);
    assert.match(en, /value="172\.20\.10\.254"/);
    assert.doesNotMatch(en, /name="enable_dhcp"|name="cidr"/);
    const vi = render('vi');
    assert.match(vi, /Tên Network/);
    assert.match(vi, /gián đoạn kết nối/);
    assert.match(vi, /APP-SUBNET/);
  } finally {
    if (priorStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = priorStorage;
    await vite.close();
  }
});

test('semantic Network audit actions display localized labels and only safe details', async () => {
  const vite = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' });
  try {
    const { actionLabel, networkAuditDetails } = await vite.ssrLoadModule('/src/pages/AuditLog.jsx');
    const event = { resource_type: 'network', action: 'network.routing.change',
      details: { subnet_id: 'sub-1', old_router_id: 'router-a', new_router_id: 'router-b', token: 'secret' } };
    assert.equal(actionLabel(event, (key) => translate('en', key)), 'Subnet moved to another Router');
    assert.equal(actionLabel(event, (key) => translate('vi', key)), 'Chuyển Subnet sang Router khác');
    assert.equal(networkAuditDetails(event), 'sub-1 · router-a → router-b');
    assert.doesNotMatch(networkAuditDetails(event), /secret/);
  } finally { await vite.close(); }
});
