import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { translate } from '../src/i18n/index.js';

test('Router and Floating IP forms hide infrastructure source selection', async () => {
  const vite = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' });
  try {
    const { CreateRouter } = await vite.ssrLoadModule('/src/pages/Networks.jsx');
    const { AllocateModal } = await vite.ssrLoadModule('/src/pages/FloatingIPs.jsx');
    const props = { onClose() {}, onDone() {} };
    const router = renderToStaticMarkup(React.createElement(CreateRouter, props));
    const fip = renderToStaticMarkup(React.createElement(AllocateModal, props));
    assert.match(router, /Tên router/);
    assert.match(fip, /Floating IP sẽ được cấp tự động/);
    assert.doesNotMatch(router + fip, /<select|external_network_id|floating_ip_subnet_id|provider network/i);
  } finally {
    await vite.close();
  }
});

test('FIP association eligibility and interface-choice messages exist in both languages', () => {
  for (const locale of ['vi', 'en']) {
    assert.notEqual(translate(locale, 'floatingIps.noEligibleInstances'), 'floatingIps.noEligibleInstances');
    assert.notEqual(translate(locale, 'floatingIps.selectInterface'), 'floatingIps.selectInterface');
  }
});
