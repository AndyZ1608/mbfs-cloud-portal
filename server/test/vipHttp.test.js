import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

process.env.OS_MOCK = 'true';
process.env.DATA_DIR = fileURLToPath(new URL('../.test-data', import.meta.url));
process.env.DATA_ENCRYPTION_KEY = 'test-only-encryption-material';

test('VIP HTTP routes are project-scoped and emit semantic VM activity', async (t) => {
  const { createApp } = await import('../app.js');
  const { mockFetch } = await import('../mock.js');
  const { listAudit } = await import('../audit.js');
  const app = createApp({ sessionStore: null, sessionSecret: 'vip-http-test-secret' }).listen(0);
  await new Promise((resolve) => app.once('listening', resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}/api`;
  let cookie = '';
  const request = (path, method = 'GET', body) => fetch(base + path, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}),
      ...(method === 'GET' ? {} : { 'X-CMP-Request': '1', 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const login = await request('/auth/login', 'POST', { username: 'admin', password: 'demo' });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];
  const network = (await (await request('/networks')).json()).networks.find((item) =>
    item.subnet_details?.some((entry) => entry.cidr === '10.10.10.0/24'));
  assert.ok(network);
  const subnet = network.subnet_details.find((entry) => entry.cidr === '10.10.10.0/24');
  const detail = await request(`/subnets/${subnet.id}`);
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).subnet.id, subnet.id);
  const create = await request(`/subnets/${subnet.id}/vips`, 'POST', {
    name: 'HTTP-VIP', ip_address: '10.10.10.105', admin_state_up: true,
    port_security_enabled: true, security_groups: ['foreign'], project_id: 'p-devops',
  });
  assert.equal(create.status, 201);
  const vip = (await create.json()).vip;
  t.after(() => {
    const ports = mockFetch('network', 'GET', '/v2.0/ports', null, 'p-demo').ports;
    for (const port of ports.filter((item) => item.allowed_address_pairs?.some((pair) => pair.ip_address === '10.10.10.105/32'))) {
      mockFetch('network', 'PUT', `/v2.0/ports/${port.id}`, { port: { allowed_address_pairs: [] } }, 'p-demo');
    }
    try { mockFetch('network', 'DELETE', `/v2.0/ports/${vip.id}`, null, 'p-demo'); } catch { /* already deleted */ }
  });
  assert.deepEqual([vip.project_id, vip.admin_state_up, vip.port_security_enabled], ['p-demo', false, false]);
  assert.deepEqual(vip.security_groups, []);
  assert.equal(vip.device_id, '');
  const list = await request(`/subnets/${subnet.id}/vips`);
  assert.equal(list.status, 200);
  assert.ok((await list.json()).vips.some((item) => item.id === vip.id));
  const ports = await request(`/subnets/${subnet.id}/ports`);
  assert.equal(ports.status, 200);
  assert.ok((await ports.json()).ports.some((item) => item.id === vip.id && item.cmp_vip));
  const targets = (await (await request(`/vips/${vip.id}/assignments`)).json()).targets;
  assert.ok(targets.length >= 2);
  const [a, b] = targets;
  assert.equal((await request(`/vips/${vip.id}/assignments`, 'PUT', { port_ids: [a.id, b.id] })).status, 200);
  const assigned = await request(`/vips/${vip.id}/assignments`);
  assert.equal((await assigned.json()).targets.filter((item) => item.assigned).length, 2);
  const vmView = await request(`/servers/${a.device_id}/vips`);
  assert.ok((await vmView.json()).ports.some((item) => item.id === a.id && item.manageable
    && item.vips.some((entry) => entry.id === vip.id)));
  const portView = await request(`/ports/${a.id}/vips`);
  assert.ok((await portView.json()).vips.some((item) => item.id === vip.id && item.assigned));
  assert.equal((await request(`/ports/${a.id}/vips`, 'PUT', { vip_port_ids: [] })).status, 200);
  assert.equal((await request(`/ports/${a.id}/vips`, 'PUT', { vip_port_ids: [vip.id] })).status, 200);
  const vmActivity = await request(`/servers/${a.device_id}/activity`);
  assert.ok((await vmActivity.json()).entries.some((event) => event.action === 'vip.assign'
    && event.details.vip_name === 'HTTP-VIP' && event.details.target_port_id === a.id));
  const audit = listAudit({ projectId: 'p-demo', user: 'admin', limit: 50 });
  assert.ok(audit.some((event) => event.action === 'vip.create' && event.resource_id === vip.id));
  assert.ok(audit.some((event) => event.action === 'vip.assign' && event.instance_id === a.device_id));
  assert.ok(audit.some((event) => event.action === 'vip.unassign' && event.instance_id === a.device_id));
  const blocked = await request(`/vips/${vip.id}`, 'DELETE');
  assert.equal(blocked.status, 409);
  assert.deepEqual([ (await blocked.json()).code, (await request(`/subnets/${subnet.id}/vips`)).status ], ['vip_delete_assigned', 200]);
  const switched = await request('/auth/switch-project', 'POST', { projectId: 'p-devops' });
  assert.equal(switched.status, 200);
  if (switched.headers.get('set-cookie')) cookie = switched.headers.get('set-cookie').split(';')[0];
  for (const path of [`/subnets/${subnet.id}`, `/subnets/${subnet.id}/vips`, `/vips/${vip.id}/assignments`,
    `/ports/${a.id}/vips`, `/servers/${a.device_id}/vips`]) {
    assert.equal((await request(path)).status, 404, path);
  }
  assert.equal((await request(`/vips/${vip.id}`, 'DELETE')).status, 404);
  assert.equal((await request(`/vips/${vip.id}/assignments`, 'PUT', { port_ids: [] })).status, 404);
  assert.equal((await request(`/ports/${a.id}/vips`, 'PUT', { vip_port_ids: [] })).status, 404);
  assert.ok(!(await (await request('/audit?limit=100')).json()).entries.some((event) => event.resource_id === vip.id));
  const back = await request('/auth/switch-project', 'POST', { projectId: 'p-demo' });
  assert.equal(back.status, 200);
  if (back.headers.get('set-cookie')) cookie = back.headers.get('set-cookie').split(';')[0];
  assert.equal((await request(`/vips/${vip.id}/assignments`, 'PUT', { port_ids: [] })).status, 200);
  assert.equal((await request(`/vips/${vip.id}`, 'DELETE')).status, 200);
});
