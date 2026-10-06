import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

process.env.OS_MOCK = 'true';
process.env.DATA_DIR = fileURLToPath(new URL('../.test-data', import.meta.url));
process.env.DATA_ENCRYPTION_KEY = 'test-only-encryption-material';

test('HTTP Router/FIP policy uses configured infrastructure without exposing or accepting provider IDs', async (t) => {
  const { mockFetch } = await import('../mock.js');
  const external = mockFetch('network', 'GET', '/v2.0/networks?router:external=true').networks[0];
  const subnet = mockFetch('network', 'GET', '/v2.0/subnets').subnets.find((item) => item.network_id === external.id);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'cmp-networking-config-test-'));
  const configPath = path.join(tempDir, 'application.yml');
  await writeFile(configPath, `networking:\n  external_network_id: "${external.id}"\n  floating_ip_subnet_id: "${subnet.id}"\n`);
  const previousConfigPath = process.env.CMP_CONFIG_FILE;
  process.env.CMP_CONFIG_FILE = configPath;
  t.after(async () => {
    if (previousConfigPath === undefined) delete process.env.CMP_CONFIG_FILE;
    else process.env.CMP_CONFIG_FILE = previousConfigPath;
    await rm(tempDir, { recursive: true, force: true });
  });

  const { createApp } = await import('../app.js');
  const app = createApp({ sessionStore: null, sessionSecret: 'external-networking-http-test-secret' }).listen(0);
  await new Promise((resolve) => app.once('listening', resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}/api`;
  let cookie;
  const request = (url, method = 'GET', body) => fetch(base + url, { method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(method === 'GET' ? {} : {
      'X-CMP-Request': '1', 'Content-Type': 'application/json',
    }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const login = await request('/auth/login', 'POST', { username: 'admin', password: 'demo' });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];
  const servers = (await (await request('/servers')).json()).servers;
  const server = servers.find((item) => item.name === 'portal-web-01');
  const ownPort = mockFetch('network', 'GET', `/v2.0/ports?device_id=${server.id}`, null, 'p-demo').ports[0];
  assert.equal((await request('/external-networks')).status, 404);

  const legacy = mockFetch('network', 'POST', '/v2.0/routers', { router: { name: 'legacy-no-gateway' } }, 'p-demo').router;
  t.after(() => mockFetch('network', 'DELETE', `/v2.0/routers/${legacy.id}`, null, 'p-demo'));
  assert.equal((await request('/routers', 'POST', { name: 'malicious', external_network_id: 'other' })).status, 400);
  const createdResponse = await request('/routers', 'POST', { name: 'HQS-Router' });
  assert.equal(createdResponse.status, 200);
  const created = (await createdResponse.json()).router;
  assert.equal(created.project_id, 'p-demo');
  assert.equal(created.external_connectivity, true);
  assert.equal(created.external_gateway_info, undefined);
  assert.equal(mockFetch('network', 'GET', `/v2.0/routers/${created.id}`, null, 'p-demo').router.external_gateway_info.network_id, external.id);
  t.after(() => mockFetch('network', 'DELETE', `/v2.0/routers/${created.id}`, null, 'p-demo'));
  assert.equal((await request('/routers')).status, 200);
  assert.equal((await request('/routers/' + legacy.id).then((response) => response.json())).router.external_connectivity, false);
  assert.equal(mockFetch('network', 'GET', `/v2.0/routers/${legacy.id}`, null, 'p-demo').router.external_gateway_info, null);

  assert.equal((await request('/floatingips', 'POST', { floating_network_id: external.id })).status, 400);
  const allocatedResponse = await request('/floatingips', 'POST');
  assert.equal(allocatedResponse.status, 200);
  const fip = (await allocatedResponse.json()).floatingip;
  assert.equal(fip.project_id, 'p-demo');
  assert.equal(fip.floating_network_id, undefined);
  assert.equal(fip.subnet_id, undefined);
  const providerFip = mockFetch('network', 'GET', `/v2.0/floatingips/${fip.id}`, null, 'p-demo').floatingip;
  assert.equal(providerFip.floating_network_id, external.id);
  assert.equal(providerFip.subnet_id, subnet.id);
  assert.match(providerFip.floating_ip_address, /^203\.0\.113\./);
  const eligible = (await (await request(`/floatingips/${fip.id}/eligible-servers`)).json()).servers;
  assert.equal(eligible.find((item) => item.id === server.id)?.ports.length, 1);
  const mockPorts = mockFetch('network', 'GET', '/v2.0/ports').ports;
  const lbPort = mockPorts.find((port) => port.project_id === 'p-demo' && port.device_owner === 'octavia');
  assert.ok(lbPort);
  assert.equal((await request(`/floatingips/${fip.id}/associate`, 'POST', { port_id: lbPort.id })).status, 200);
  assert.equal((await request(`/floatingips/${fip.id}/disassociate`, 'POST')).status, 200);
  const routerPort = mockPorts.find((port) => port.project_id === 'p-demo' && port.device_owner === 'network:router_interface');
  assert.equal((await request(`/floatingips/${fip.id}/associate`, 'POST', { port_id: routerPort.id })).status, 404);
  const extraPort = { ...ownPort, id: randomUUID(), fixed_ips: [{ ...ownPort.fixed_ips[0], ip_address: '10.10.10.222' }] };
  mockPorts.push(extraPort);
  t.after(() => mockPorts.splice(mockPorts.findIndex((port) => port.id === extraPort.id), 1));
  const multiple = (await (await request(`/floatingips/${fip.id}/eligible-servers`)).json()).servers;
  assert.equal(multiple.find((item) => item.id === server.id)?.ports.length, 2);
  assert.equal((await request(`/floatingips/${fip.id}/associate`, 'POST', { server_id: server.id })).status, 409);
  assert.equal((await request(`/floatingips/${fip.id}/associate`, 'POST', { server_id: server.id, port_id: ownPort.id })).status, 200);
  assert.equal((await request(`/floatingips/${fip.id}`, 'DELETE')).status, 409);
  assert.equal((await request(`/floatingips/${fip.id}/disassociate`, 'POST')).status, 200);
  assert.equal((await request(`/floatingips/${fip.id}`, 'DELETE')).status, 200);

  const switched = await request('/auth/switch-project', 'POST', { projectId: 'p-devops' });
  assert.equal(switched.status, 200);
  if (switched.headers.get('set-cookie')) cookie = switched.headers.get('set-cookie').split(';')[0];
  const otherRouterResponse = await request('/routers', 'POST', { name: 'Project-B-Router' });
  assert.equal(otherRouterResponse.status, 200);
  const otherRouter = (await otherRouterResponse.json()).router;
  assert.equal(otherRouter.project_id, 'p-devops');
  const otherFipResponse = await request('/floatingips', 'POST');
  assert.equal(otherFipResponse.status, 200);
  const otherFip = (await otherFipResponse.json()).floatingip;
  assert.equal(otherFip.project_id, 'p-devops');
  assert.equal((await request(`/floatingips/${otherFip.id}/associate`, 'POST', { port_id: ownPort.id })).status, 404);
  assert.equal(mockFetch('network', 'GET', `/v2.0/floatingips/${otherFip.id}`, null, 'p-devops').floatingip.port_id, null);
  assert.equal((await request(`/floatingips/${otherFip.id}`, 'DELETE')).status, 200);
  assert.equal((await request(`/routers/${otherRouter.id}`, 'DELETE')).status, 200);
});
