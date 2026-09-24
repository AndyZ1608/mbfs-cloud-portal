import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { apiErrorMessage } from '../src/api.js';
import { setRuntimeLocale, translate } from '../src/i18n/index.js';

test('Create Network renders two modes, an isolated gateway hint, and no DHCP control', async () => {
  const vite = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' });
  try {
    const { CreateNetwork } = await vite.ssrLoadModule('/src/pages/Networks.jsx');
    const props = { routers: [{ id: 'router-own', name: 'XPLAT Router' }], onClose() {}, onDone() {} };
    const isolated = renderToStaticMarkup(React.createElement(CreateNetwork, props));
    assert.match(isolated, /Chế độ Network/);
    assert.match(isolated.match(/<input[^>]*value="isolated"[^>]*>/)?.[0] || '', /checked=""/);
    assert.match(isolated, /Gateway vẫn được cấu hình/);
    assert.match(isolated, /Gateway IP/);
    assert.doesNotMatch(isolated, /<select|DHCP|enable_dhcp|XPLAT Router/);

    const routed = renderToStaticMarkup(React.createElement(CreateNetwork, { ...props, initialMode: 'routed' }));
    assert.match(routed.match(/<input[^>]*value="routed"[^>]*>/)?.[0] || '', /checked=""/);
    assert.match(routed, /<select[^>]*required=""/);
    assert.match(routed, /XPLAT Router/);
    assert.match(routed, /Gateway IP/);
    assert.doesNotMatch(routed, /Gateway vẫn được cấu hình|DHCP|enable_dhcp/);
  } finally { await vite.close(); }
});

test('form requires Router only for Routed; isolated payload drops stale Router and DHCP overrides', async () => {
  const vite = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' });
  try {
    const { createNetworkValidationKey, createNetworkBody, runNetworkCreate } = await vite.ssrLoadModule('/src/pages/Networks.jsx');
    const form = { name: 'app', cidr: '172.30.20.0/24', gateway_ip: '172.30.20.1', dns: '8.8.8.8', mode: 'isolated', router_id: 'stale', enable_dhcp: false };
    assert.equal(createNetworkValidationKey(form), null);
    assert.deepEqual(createNetworkBody(form), {
      name: 'app', cidr: '172.30.20.0/24', gateway_ip: '172.30.20.1', dns: '8.8.8.8', mode: 'isolated',
    });
    assert.equal(createNetworkValidationKey({ ...form, mode: 'routed', router_id: '' }), 'networks.create.routerRequired');
    assert.equal(createNetworkBody({ ...form, mode: 'routed', router_id: 'own' }).router_id, 'own');
    const calls = [];
    await runNetworkCreate(form, {
      request: async (...args) => { calls.push(['request', ...args]); },
      notify: (...args) => calls.push(['toast', ...args]),
      translate: (key) => translate('en', key),
      onDone: () => calls.push(['closed']),
    });
    assert.equal(calls[0][0], 'request');
    assert.equal(calls[0][2].body.router_id, undefined);
    assert.equal(calls[1][1], 'Isolated network created successfully.');
    assert.deepEqual(calls[2], ['closed']);
  } finally { await vite.close(); }
});

test('new validation, success, and partial-failure messages translate in vi and en', () => {
  assert.equal(translate('vi', 'networks.create.routerRequired'), 'Vui lòng chọn Router cho network Routed.');
  assert.equal(translate('en', 'networks.create.routerRequired'), 'Please select a Router for the routed network.');
  assert.equal(translate('vi', 'networks.create.routedSuccess'), 'Tạo network Routed thành công.');
  assert.equal(translate('en', 'networks.create.isolatedSuccess'), 'Isolated network created successfully.');
  try {
    setRuntimeLocale('en');
    assert.match(apiErrorMessage({ code: 'network_partial_failure', resourceIds: { networkId: 'net-1', subnetId: 'sub-1' } }, 502), /net-1.*sub-1/);
    setRuntimeLocale('vi');
    assert.match(apiErrorMessage({ code: 'network_router_required' }, 400), /Vui lòng chọn Router/);
  } finally { setRuntimeLocale('vi'); }
});
