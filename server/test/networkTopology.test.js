import test from 'node:test';
import assert from 'node:assert/strict';
import { networkTopology, networkResources, createOnlySubnet } from '../networkTopology.js';

const session = { project: { id: 'project-a' } };
const network = () => ({ id: 'network-a', project_id: 'project-a', name: 'APP', subnets: [] });
const subnet = (id) => ({ id, project_id: 'project-a', network_id: 'network-a', cidr: '10.20.0.0/24' });

function provider(net, subnets, ports = []) {
  const calls = [];
  const request = async (_session, service, path, options = {}) => {
    calls.push({ service, path, options });
    if (service === 'network' && path === '/v2.0/networks/network-a') return { network: net };
    if (service === 'network' && path.startsWith('/v2.0/subnets?')) return { subnets };
    if (service === 'network' && path.startsWith('/v2.0/ports?')) return { ports };
    if (service === 'compute' && path === '/servers/detail') return { servers: [
      { id: 'vm-a', name: 'Firewall A', project_id: 'project-a' },
      { id: 'vm-foreign', name: 'Foreign VM', project_id: 'project-b' },
    ] };
    if (service === 'network' && path === '/v2.0/subnets/subnet-a') return { subnet: subnets[0] };
    if (service === 'network' && path === '/v2.0/subnets' && options.method === 'POST') {
      const created = { ...options.body.subnet, id: 'subnet-a' };
      subnets.push(created); net.subnets.push(created.id);
      return { subnet: created };
    }
    throw new Error(`Unexpected request: ${service} ${path}`);
  };
  return { request, calls };
}

test('Network detail resolves zero, one and multiple Subnets without choosing an arbitrary first', async () => {
  const net = network();
  const subs = [];
  const { request } = provider(net, subs);
  assert.equal((await networkTopology(session, net.id, request)).subnet_state, 'none');
  subs.push(subnet('subnet-a')); net.subnets.push('subnet-a');
  assert.equal((await networkTopology(session, net.id, request)).subnet.id, 'subnet-a');
  subs.push(subnet('subnet-b')); net.subnets.push('subnet-b');
  const ambiguous = await networkResources(session, net.id, request);
  assert.equal(ambiguous.subnet_state, 'multiple');
  assert.equal(ambiguous.subnet, null);
  assert.deepEqual(ambiguous.ports, []);
  assert.deepEqual(ambiguous.vips, []);
});

test('CMP creates only the first Subnet and rejects a second or a foreign project before POST', async () => {
  const net = network();
  const subs = [];
  const { request, calls } = provider(net, subs);
  await assert.rejects(createOnlySubnet({ project: { id: 'project-b' } }, net.id,
    { cidr: '10.20.0.0/24' }, request), { status: 404 });
  assert.equal(calls.filter((call) => call.options.method === 'POST').length, 0);
  const created = await createOnlySubnet(session, net.id, { cidr: '10.20.0.0/24' }, request);
  assert.equal(created.subnet.network_id, net.id);
  await assert.rejects(createOnlySubnet(session, net.id, { cidr: '10.21.0.0/24' }, request),
    { code: 'network_multiple_subnets' });
  assert.equal(calls.filter((call) => call.options.method === 'POST').length, 1);
});

test('Network resources include only current-project Ports in the selected Network', async () => {
  const net = network(); net.subnets.push('subnet-a');
  const subs = [subnet('subnet-a')];
  const ports = [
    { id: 'port-a', project_id: 'project-a', network_id: net.id, device_owner: 'compute:nova',
      device_id: 'vm-a', fixed_ips: [{ subnet_id: 'subnet-a', ip_address: '10.20.0.10' }] },
    { id: 'port-foreign', project_id: 'project-b', network_id: net.id, device_owner: 'compute:nova',
      device_id: 'vm-foreign', fixed_ips: [{ subnet_id: 'subnet-a', ip_address: '10.20.0.11' }] },
    { id: 'port-other-network', project_id: 'project-a', network_id: 'network-b',
      fixed_ips: [{ subnet_id: 'subnet-a', ip_address: '10.20.0.12' }] },
  ];
  const { request } = provider(net, subs, ports);
  const result = await networkResources(session, net.id, request);
  assert.deepEqual(result.ports.map((port) => port.id), ['port-a']);
  assert.equal(result.ports[0].instance_name, 'Firewall A');
  await assert.rejects(networkResources({ project: { id: 'project-b' } }, net.id, request), { status: 404 });
});
