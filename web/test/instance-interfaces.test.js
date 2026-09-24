import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

test('shared VM interface form offers network, dependent subnet, optional IP, and fixed default SG in vi/en', async () => {
  const vite = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' });
  const priorStorage = globalThis.localStorage;
  try {
    const { default: Fields, newInterface, subnetsForNetwork, selectInterfaceNetwork, addInterface, removeInterface, validInterfaces } = await vite.ssrLoadModule('/src/components/NetworkInterfaceFields.jsx');
    const { LocaleProvider } = await vite.ssrLoadModule('/src/i18n/react.jsx');
    const networks = [
      { id: 'net-a', name: 'APP-NET', subnet_details: [{ id: 'sub-a', name: 'app-subnet', cidr: '10.1.0.0/24' }] },
      { id: 'net-b', name: 'BACKUP-NET', subnet_details: [{ id: 'sub-b', name: 'backup-subnet', cidr: '10.2.0.0/24' }] },
    ];
    const first = newInterface(networks);
    assert.deepEqual(first, { network_id: 'net-a', subnet_id: 'sub-a', ip_address: '' });
    assert.deepEqual(subnetsForNetwork(networks, 'net-b').map((subnet) => subnet.id), ['sub-b']);
    assert.deepEqual(selectInterfaceNetwork('net-b'), { network_id: 'net-b', subnet_id: '', ip_address: '' });
    assert.equal(addInterface([first], networks).length, 2);
    assert.deepEqual(removeInterface(addInterface([first], networks), 1), [first]);
    assert.deepEqual(removeInterface([first], 0), [first]);
    assert.equal(validInterfaces([first, { network_id: 'net-b', subnet_id: 'sub-a', ip_address: '' }], networks), false);
    assert.equal(validInterfaces([first, { network_id: 'net-b', subnet_id: 'sub-b', ip_address: '' }], networks), true);
    const render = (locale, value) => {
      globalThis.localStorage = { getItem: (key) => key === 'cmp.locale' ? locale : null };
      return renderToStaticMarkup(React.createElement(LocaleProvider, null,
        React.createElement(Fields, { value, networks, index: 0, onChange: () => {} })));
    };
    const en = render('en', first);
    assert.match(en, /Interface 1/);
    assert.match(en, /IP Address/);
    assert.match(en, /Optional — Neutron allocates an IP/);
    assert.match(en, /Security Group/);
    assert.match(en, />default</);
    assert.match(en, /value="sub-a"/);
    assert.doesNotMatch(en, /value="sub-b"/);
    const vi = render('vi', first);
    assert.match(vi, /Địa chỉ IP/);
    assert.match(vi, /Không bắt buộc/);
    assert.match(vi, />default</);
  } finally {
    if (priorStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = priorStorage;
    await vite.close();
  }
});
