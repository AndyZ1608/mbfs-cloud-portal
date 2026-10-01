import test from 'node:test';
import assert from 'node:assert/strict';
import { listProjectNeutron } from '../projectResourceList.js';

const session = { project: { id: 'project-a' }, roles: ['admin'] };

test('Neutron network listing follows provider pages and excludes foreign-project matches', async () => {
  const calls = [];
  const request = async (_session, service, path) => {
    assert.equal(service, 'network');
    const url = new URL(path, 'http://cmp.test');
    assert.equal(url.searchParams.get('project_id'), 'project-a');
    calls.push(url);
    if (!url.searchParams.has('marker')) return {
      networks: [...Array.from({ length: 999 }, (_, index) => ({ id: `net-${index}`,
        project_id: 'project-a', name: `APP-NET-${index}` })),
      { id: 'foreign', project_id: 'project-b', name: 'B-NET-NEW' }],
      networks_links: [{ rel: 'next', href: 'http://neutron.test/v2.0/networks?marker=foreign' }],
    };
    assert.equal(url.searchParams.get('marker'), 'foreign');
    return { networks: [{ id: 'last', project_id: 'project-a', name: 'SPECIAL-NET-NEW' }] };
  };
  const networks = await listProjectNeutron(session, 'networks', request);
  assert.equal(networks.length, 1000);
  assert.equal(networks.at(-1).name, 'SPECIAL-NET-NEW');
  assert.ok(!networks.some((network) => network.name === 'B-NET-NEW'));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].searchParams.get('limit'), '1000');
});

test('Neutron subnet listing returns the complete current-project collection', async () => {
  const subnets = await listProjectNeutron(session, 'subnets', async (_session, _service, path) => {
    assert.match(path, /project_id=project-a/);
    return { subnets: [{ id: 'a', project_id: 'project-a' }, { id: 'b', project_id: 'project-b' }] };
  });
  assert.deepEqual(subnets.map((subnet) => subnet.id), ['a']);
});
