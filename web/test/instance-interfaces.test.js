import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { composeSegmentedIp, fixedIpError, segmentedHostOctets, subnetAddressInfo } from '../src/fixedIp.js';

test('CIDR math derives actual /24, /16 and /8 network prefixes and composes full IP values', () => {
  for (const [cidr, prefix, hosts] of [
    ['10.20.31.128/24', ['10', '20', '31'], ['50']],
    ['10.20.99.99/16', ['10', '20'], ['31', '50']],
    ['10.99.99.99/8', ['10'], ['20', '31', '50']],
  ]) {
    const info = subnetAddressInfo(cidr);
    assert.deepEqual(info.fixedParts, prefix);
    assert.deepEqual(segmentedHostOctets(info, '10.20.31.50'), hosts);
    assert.equal(composeSegmentedIp(info, hosts), '10.20.31.50');
    assert.equal(composeSegmentedIp(info, hosts.map(() => '')), '');
  }
  assert.equal(subnetAddressInfo('10.20.16.0/20').fixedOctets, 0);
  assert.equal(subnetAddressInfo('10.20.31.4/32').fixedOctets, 0);
  assert.equal(subnetAddressInfo('2001:db8::/64').fixedOctets, 0);
});

test('fixed IP validation distinguishes partial, invalid, out-of-subnet, network, broadcast and gateway', () => {
  const subnet = { cidr: '10.20.31.128/24', gateway_ip: '10.20.31.1' };
  assert.equal(fixedIpError('', subnet), null);
  assert.equal(fixedIpError('10.20.31.50', subnet), null);
  assert.equal(fixedIpError('10.20.31.', subnet), 'incompleteIp');
  assert.equal(fixedIpError('10.20.31.300', subnet), 'invalidIp');
  assert.equal(fixedIpError('10.20.31.-1', subnet), 'invalidIp');
  assert.equal(fixedIpError('10.20.31.a', subnet), 'invalidIp');
  assert.equal(fixedIpError('10.20.40.50', subnet), 'ipOutsideSubnet');
  assert.equal(fixedIpError('10.20.31.0', subnet), 'networkAddressNotAllowed');
  assert.equal(fixedIpError('10.20.31.255', subnet), 'broadcastAddressNotAllowed');
  assert.equal(fixedIpError('10.20.31.1', subnet), 'gatewayAddressNotAllowed');
  assert.equal(fixedIpError('10.20.31.50', { cidr: '10.20.16.0/20' }), null);
  assert.equal(fixedIpError('10.20.40.10', { cidr: '10.20.16.0/20' }), 'ipOutsideSubnet');
  assert.equal(fixedIpError('10.20.0.255', { cidr: '10.20.0.0/16' }), null);
  assert.equal(fixedIpError('2001:db8::50', { cidr: '2001:db8::/64' }), null);
  assert.equal(fixedIpError('2001:db9::50', { cidr: '2001:db8::/64' }), 'ipOutsideSubnet');
});

test('shared VM interface form offers subnet-aware IP, automatic allocation, and fixed default SG in vi/en', async () => {
  const vite = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' });
  const priorStorage = globalThis.localStorage;
  try {
    const { default: Fields, newInterface, subnetsForNetwork, selectInterfaceNetwork,
      selectInterfaceSubnet, interfaceRequestSpec, interfaceValidationError,
      addInterface, removeInterface, validInterfaces } = await vite.ssrLoadModule('/src/components/NetworkInterfaceFields.jsx');
    const { LocaleProvider } = await vite.ssrLoadModule('/src/i18n/react.jsx');
    const networks = [
      { id: 'net-a', name: 'APP-NET', subnet_details: [{ id: 'sub-a', name: 'app-subnet', cidr: '10.1.0.0/24' }] },
      { id: 'net-b', name: 'BACKUP-NET', subnet_details: [{ id: 'sub-b', name: 'backup-subnet', cidr: '10.2.0.0/24' }] },
    ];
    const first = newInterface(networks);
    assert.deepEqual(first, { network_id: 'net-a', subnet_id: 'sub-a', ip_address: '' });
    assert.deepEqual(subnetsForNetwork(networks, 'net-b').map((subnet) => subnet.id), ['sub-b']);
    assert.deepEqual(selectInterfaceNetwork('net-b'), { network_id: 'net-b', subnet_id: '', ip_address: '' });
    assert.deepEqual(selectInterfaceSubnet({ ...first, ip_address: '10.1.0.50' }, 'sub-b'),
      { network_id: 'net-a', subnet_id: 'sub-b', ip_address: '' });
    assert.equal(addInterface([first], networks).length, 2);
    assert.deepEqual(removeInterface(addInterface([first], networks), 1), [first]);
    assert.deepEqual(removeInterface([first], 0), [first]);
    assert.equal(validInterfaces([first, { network_id: 'net-b', subnet_id: 'sub-a', ip_address: '' }], networks), false);
    assert.equal(validInterfaces([first, { network_id: 'net-b', subnet_id: 'sub-b', ip_address: '' }], networks), true);
    assert.equal(validInterfaces([{ ...first, ip_address: '10.1.0.' }], networks), false);
    assert.equal(interfaceValidationError([{ ...first, ip_address: '10.1.0.' }], networks), 'instance.networkInterfaces.incompleteIp');
    assert.equal(validInterfaces([{ ...first, ip_address: '10.1.0.50' }], networks), true);
    assert.deepEqual(interfaceRequestSpec(first), { network_id: 'net-a', subnet_id: 'sub-a', ip_address: null });
    assert.deepEqual(interfaceRequestSpec({ ...first, ip_address: '10.1.0.50' }),
      { network_id: 'net-a', subnet_id: 'sub-a', ip_address: '10.1.0.50' });
    const render = (locale, value, choices = networks) => {
      globalThis.localStorage = { getItem: (key) => key === 'cmp.locale' ? locale : null };
      return renderToStaticMarkup(React.createElement(LocaleProvider, null,
        React.createElement(Fields, { value, networks: choices, index: 0, onChange: () => {} })));
    };
    const en = render('en', first);
    assert.match(en, /Interface 1/);
    assert.match(en, /IP Address/);
    assert.match(en, /Leave blank to let Neutron assign an IP automatically/);
    assert.match(en, /vm-ip-prefix[^>]*>10\.1\.0\./);
    assert.equal((en.match(/IP host octet/g) || []).length, 1);
    assert.match(en, /Security Group/);
    assert.match(en, />default</);
    assert.match(en, /value="sub-a"/);
    assert.doesNotMatch(en, /value="sub-b"/);
    const vi = render('vi', first);
    assert.match(vi, /Địa chỉ IP/);
    assert.match(vi, /Để trống để Neutron tự cấp IP/);
    assert.match(vi, />default</);
    const existing = render('en', { ...first, ip_address: '10.1.0.50' });
    assert.match(existing, /aria-label="IP host octet 1"[^>]*value="50"/);
    for (const [cidr, prefix, hostCount] of [
      ['10.20.31.128/24', '10.20.31.', 1],
      ['10.20.99.99/16', '10.20.', 2],
      ['10.99.99.99/8', '10.', 3],
    ]) {
      const choice = [{ id: 'net-c', name: 'C', subnet_details: [{ id: 'sub-c', cidr }] }];
      const markup = render('en', { network_id: 'net-c', subnet_id: 'sub-c', ip_address: '10.20.31.50' }, choice);
      assert.ok(markup.includes(`>${prefix}</span>`), cidr);
      assert.equal((markup.match(/aria-label="IP host octet/g) || []).length, hostCount, cidr);
    }
    const fallbackNetworks = [{ id: 'net-c', name: 'C', subnet_details: [{ id: 'sub-c', cidr: '10.20.16.0/20' }] }];
    const fallback = render('en', { network_id: 'net-c', subnet_id: 'sub-c', ip_address: '10.20.31.50' }, fallbackNetworks);
    assert.match(fallback, /Subnet: 10\.20\.16\.0\/20/);
    assert.doesNotMatch(fallback, /vm-ip-control/);
    const ipv6 = render('en', { network_id: 'net-c', subnet_id: 'sub-c', ip_address: '2001:db8::50' },
      [{ id: 'net-c', name: 'C', subnet_details: [{ id: 'sub-c', cidr: '2001:db8::/64' }] }]);
    assert.doesNotMatch(ipv6, /vm-ip-control/);
    assert.match(ipv6, /value="2001:db8::50"/);
  } finally {
    if (priorStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = priorStorage;
    await vite.close();
  }
});
