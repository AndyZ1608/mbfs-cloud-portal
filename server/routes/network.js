import { Router } from 'express';
import { osFetch, OSError } from '../openstack.js';
import { currentProjectId, fetchOwned, isOwned, isUsableNetwork, owned, projectQuery } from '../projectScope.js';
import { createNetwork } from '../networkCreation.js';

const router = Router();

// ---------- Networks + Subnets ----------

router.get('/networks', async (req, res, next) => {
  try {
    const sess = req.session.os;
    const [nets, subs] = await Promise.all([
      osFetch(sess, 'network', projectQuery(sess, '/v2.0/networks')),
      osFetch(sess, 'network', projectQuery(sess, '/v2.0/subnets')),
    ]);
    const subMap = {};
    owned(subs.subnets, sess).forEach((s) => (subMap[s.id] = s));
    const networks = owned(nets.networks, sess).map((n) => ({
      ...n,
      subnet_details: (n.subnets || []).map((id) => subMap[id]).filter(Boolean),
    }));
    res.json({ networks });
  } catch (e) { next(e); }
});

// Deliberate selector: project-owned plus Neutron-shared tenant networks, never external networks.
router.get('/available-networks', async (req, res, next) => {
  try {
    const sess = req.session.os;
    const [mine, shared, subs] = await Promise.all([
      osFetch(sess, 'network', projectQuery(sess, '/v2.0/networks')),
      osFetch(sess, 'network', '/v2.0/networks?shared=true'),
      osFetch(sess, 'network', projectQuery(sess, '/v2.0/subnets')),
    ]);
    const subMap = Object.fromEntries(owned(subs.subnets, sess).map((s) => [s.id, s]));
    const byId = new Map();
    for (const network of [...(mine.networks || []), ...(shared.networks || [])]) {
      if (isUsableNetwork(network, sess)) byId.set(network.id, network);
    }
    for (const network of byId.values()) {
      if (isOwned(network, sess) || !network.shared) continue;
      const response = await osFetch(sess, 'network', `/v2.0/subnets?network_id=${encodeURIComponent(network.id)}`);
      for (const subnet of response.subnets || []) {
        if (subnet.network_id === network.id && network.subnets?.includes(subnet.id)) subMap[subnet.id] = subnet;
      }
    }
    res.json({ networks: [...byId.values()].map((network) => ({
      ...network,
      subnet_details: (network.subnets || []).map((id) => subMap[id]).filter(Boolean),
    })) });
  } catch (e) { next(e); }
});

router.get('/external-networks', async (req, res, next) => {
  try {
    const data = await osFetch(req.session.os, 'network', '/v2.0/networks?router:external=true');
    res.json({ networks: (data.networks || []).filter((network) => network['router:external'] === true) });
  } catch (e) { next(e); }
});

router.get('/networks/:id', async (req, res, next) => {
  try { res.json({ network: await fetchOwned(req.session.os, 'network', `/v2.0/networks/${req.params.id}`, 'network') }); }
  catch (error) { next(error); }
});

// Tạo network + subnet, và gắn Router chỉ khi người dùng chọn Routed.
router.post('/networks', async (req, res, next) => {
  const sess = req.session.os;
  try {
    const result = await createNetwork(sess, req.body);
    console.log(`[network] CREATE network=${result.network.id} mode=${result.mode} by=${sess.user.name}`);
    res.json(result);
  } catch (e) { next(e); }
});

router.delete('/networks/:id', async (req, res, next) => {
  try {
    await fetchOwned(req.session.os, 'network', `/v2.0/networks/${req.params.id}`, 'network');
    await osFetch(req.session.os, 'network', `/v2.0/networks/${req.params.id}`, { method: 'DELETE' });
    console.log(`[network] DELETE network=${req.params.id} by=${req.session.os.user.name}`);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- Ports ----------

router.get('/ports', async (req, res, next) => {
  try {
    const sess = req.session.os;
    const dev = req.query.device_id;
    const path = projectQuery(sess, '/v2.0/ports', dev ? { device_id: String(dev) } : {});
    const data = await osFetch(sess, 'network', path);
    res.json({ ports: owned(data.ports, sess) });
  } catch (e) { next(e); }
});

// ---------- Routers ----------

router.get('/routers', async (req, res, next) => {
  try {
    const sess = req.session.os;
    const data = await osFetch(sess, 'network', projectQuery(sess, '/v2.0/routers'));
    res.json({ routers: owned(data.routers, sess) });
  } catch (e) { next(e); }
});

router.get('/routers/:id', async (req, res, next) => {
  try { res.json({ router: await fetchOwned(req.session.os, 'network', `/v2.0/routers/${req.params.id}`, 'router') }); }
  catch (error) { next(error); }
});

router.post('/routers', async (req, res, next) => {
  try {
    const { name, external_network_id } = req.body || {};
    if (!name) throw new OSError(400, 'Thiếu tên router');
    const sess = req.session.os;
    const body = { router: { name, project_id: currentProjectId(sess) } };
    if (external_network_id) {
      const external = (await osFetch(sess, 'network', `/v2.0/networks/${external_network_id}`)).network;
      if (external?.['router:external'] !== true) throw new OSError(404, 'Không tìm thấy tài nguyên trong project hiện tại.', 'resource_not_found');
      body.router.external_gateway_info = { network_id: external_network_id };
    }
    const data = await osFetch(req.session.os, 'network', '/v2.0/routers', { method: 'POST', body });
    console.log(`[network] CREATE router name=${name} by=${req.session.os.user.name}`);
    res.json(data);
  } catch (e) { next(e); }
});

router.get('/routers/:id/interfaces', async (req, res, next) => {
  try {
    const sess = req.session.os;
    await fetchOwned(sess, 'network', `/v2.0/routers/${req.params.id}`, 'router');
    const data = await osFetch(sess, 'network', projectQuery(sess, '/v2.0/ports', { device_id: req.params.id }));
    const ifaces = owned(data.ports, sess).filter((p) => (p.device_owner || '').includes('router_interface') || (p.device_owner || '') === 'network:ha_router_replicated_interface');
    res.json({ interfaces: ifaces });
  } catch (e) { next(e); }
});

router.post('/routers/:id/interfaces', async (req, res, next) => {
  try {
    const { subnet_id } = req.body || {};
    if (!subnet_id) throw new OSError(400, 'Thiếu subnet_id');
    await fetchOwned(req.session.os, 'network', `/v2.0/routers/${req.params.id}`, 'router');
    await fetchOwned(req.session.os, 'network', `/v2.0/subnets/${subnet_id}`, 'subnet');
    const data = await osFetch(req.session.os, 'network', `/v2.0/routers/${req.params.id}/add_router_interface`, { method: 'PUT', body: { subnet_id } });
    res.json(data);
  } catch (e) { next(e); }
});

router.delete('/routers/:id/interfaces/:subnetId', async (req, res, next) => {
  try {
    await fetchOwned(req.session.os, 'network', `/v2.0/routers/${req.params.id}`, 'router');
    await fetchOwned(req.session.os, 'network', `/v2.0/subnets/${req.params.subnetId}`, 'subnet');
    const data = await osFetch(req.session.os, 'network', `/v2.0/routers/${req.params.id}/remove_router_interface`, { method: 'PUT', body: { subnet_id: req.params.subnetId } });
    res.json(data || { ok: true });
  } catch (e) { next(e); }
});

router.delete('/routers/:id', async (req, res, next) => {
  try {
    await fetchOwned(req.session.os, 'network', `/v2.0/routers/${req.params.id}`, 'router');
    await osFetch(req.session.os, 'network', `/v2.0/routers/${req.params.id}`, { method: 'DELETE' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- Floating IPs ----------

// Danh sách FIP, kèm tên máy ảo đang gắn (nếu có)
router.get('/floatingips', async (req, res, next) => {
  try {
    const sess = req.session.os;
    const data = await osFetch(sess, 'network', projectQuery(sess, '/v2.0/floatingips'));
    const fips = owned(data.floatingips, sess);
    const portIds = fips.filter((f) => f.port_id).map((f) => f.port_id);
    let portMap = {};
    if (portIds.length) {
      const qs = portIds.map((id) => `id=${encodeURIComponent(id)}`).join('&');
      const pr = await osFetch(sess, 'network', `/v2.0/ports?${qs}`).catch(() => ({ ports: [] }));
      owned(pr.ports, sess).forEach((p) => (portMap[p.id] = p));
    }
    let serverMap = {};
    if (Object.values(portMap).some((p) => (p.device_owner || '').startsWith('compute'))) {
      const sv = await osFetch(sess, 'compute', '/servers/detail').catch(() => ({ servers: [] }));
      owned(sv.servers, sess).forEach((s) => (serverMap[s.id] = s.name));
    }
    res.json({
      floatingips: fips.map((f) => {
        const p = f.port_id ? portMap[f.port_id] : null;
        return { ...f, instance_name: p ? serverMap[p.device_id] || null : null };
      }),
    });
  } catch (e) { next(e); }
});

router.post('/floatingips', async (req, res, next) => {
  try {
    const { floating_network_id } = req.body || {};
    if (!floating_network_id) throw new OSError(400, 'Chưa chọn mạng external');
    const sess = req.session.os;
    const external = (await osFetch(sess, 'network', `/v2.0/networks/${floating_network_id}`)).network;
    if (external?.['router:external'] !== true) throw new OSError(404, 'Không tìm thấy tài nguyên trong project hiện tại.', 'resource_not_found');
    const data = await osFetch(sess, 'network', '/v2.0/floatingips', { method: 'POST', body: { floatingip: { floating_network_id, project_id: currentProjectId(sess) } } });
    console.log(`[network] ALLOCATE fip=${data.floatingip?.floating_ip_address} by=${req.session.os.user.name}`);
    res.json(data);
  } catch (e) { next(e); }
});

// Gắn FIP vào máy ảo: tự tìm port của máy
router.post('/floatingips/:id/associate', async (req, res, next) => {
  try {
    const sess = req.session.os;
    const { server_id, port_id } = req.body || {};
    await fetchOwned(sess, 'network', `/v2.0/floatingips/${req.params.id}`, 'floatingip');
    let portId = port_id;
    if (server_id) await fetchOwned(sess, 'compute', `/servers/${server_id}`, 'server');
    if (!portId) {
      if (!server_id) throw new OSError(400, 'Chưa chọn máy ảo hoặc port');
      const pr = await osFetch(sess, 'network', `/v2.0/ports?device_id=${encodeURIComponent(server_id)}`);
      const port = owned(pr.ports, sess)[0];
      if (!port) throw new OSError(404, 'Máy ảo chưa có port mạng (có thể đang khởi tạo)');
      portId = port.id;
    }
    const port = await fetchOwned(sess, 'network', `/v2.0/ports/${portId}`, 'port');
    if (server_id && port.device_id !== server_id) throw new OSError(404, 'Không tìm thấy tài nguyên trong project hiện tại.', 'resource_not_found');
    const data = await osFetch(sess, 'network', `/v2.0/floatingips/${req.params.id}`, { method: 'PUT', body: { floatingip: { port_id: portId } } });
    console.log(`[network] ASSOCIATE fip=${req.params.id} -> ${server_id ? 'server=' + server_id : 'port=' + portId} by=${sess.user.name}`);
    res.json(data);
  } catch (e) { next(e); }
});

router.post('/floatingips/:id/disassociate', async (req, res, next) => {
  try {
    await fetchOwned(req.session.os, 'network', `/v2.0/floatingips/${req.params.id}`, 'floatingip');
    const data = await osFetch(req.session.os, 'network', `/v2.0/floatingips/${req.params.id}`, { method: 'PUT', body: { floatingip: { port_id: null } } });
    res.json(data);
  } catch (e) { next(e); }
});

router.delete('/floatingips/:id', async (req, res, next) => {
  try {
    await fetchOwned(req.session.os, 'network', `/v2.0/floatingips/${req.params.id}`, 'floatingip');
    await osFetch(req.session.os, 'network', `/v2.0/floatingips/${req.params.id}`, { method: 'DELETE' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- Security Groups ----------

router.get('/security-groups', async (req, res, next) => {
  try {
    const sess = req.session.os;
    const data = await osFetch(sess, 'network', projectQuery(sess, '/v2.0/security-groups'));
    res.json({ security_groups: owned(data.security_groups, sess).map((group) => ({
      ...group,
      security_group_rules: (group.security_group_rules || []).filter((rule) => !rule.project_id && !rule.tenant_id || isOwned(rule, sess)),
    })) });
  } catch (e) { next(e); }
});

router.post('/security-groups', async (req, res, next) => {
  try {
    const { name, description } = req.body || {};
    if (!name) throw new OSError(400, 'Thiếu tên security group');
    const sess = req.session.os;
    const data = await osFetch(sess, 'network', '/v2.0/security-groups', { method: 'POST', body: { security_group: { name, description: description || '', project_id: currentProjectId(sess) } } });
    console.log(`[network] CREATE secgroup name=${name} by=${req.session.os.user.name}`);
    res.json(data);
  } catch (e) { next(e); }
});

router.delete('/security-groups/:id', async (req, res, next) => {
  try {
    await fetchOwned(req.session.os, 'network', `/v2.0/security-groups/${req.params.id}`, 'security_group');
    await osFetch(req.session.os, 'network', `/v2.0/security-groups/${req.params.id}`, { method: 'DELETE' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/security-group-rules', async (req, res, next) => {
  try {
    const { security_group_id, direction, protocol, port_min, port_max, remote_ip_prefix } = req.body || {};
    if (!security_group_id || !direction) throw new OSError(400, 'Thiếu thông tin rule');
    const sess = req.session.os;
    await fetchOwned(sess, 'network', `/v2.0/security-groups/${security_group_id}`, 'security_group');
    const rule = { security_group_id, direction, ethertype: 'IPv4', project_id: currentProjectId(sess) };
    if (protocol && protocol !== 'any') rule.protocol = protocol;
    if (rule.protocol === 'tcp' || rule.protocol === 'udp') {
      if (port_min) rule.port_range_min = Number(port_min);
      if (port_max || port_min) rule.port_range_max = Number(port_max || port_min);
    }
    rule.remote_ip_prefix = remote_ip_prefix || '0.0.0.0/0';
    const data = await osFetch(req.session.os, 'network', '/v2.0/security-group-rules', { method: 'POST', body: { security_group_rule: rule } });
    console.log(`[network] ADD rule sg=${security_group_id} ${direction} ${protocol || 'any'} ${port_min || ''}-${port_max || port_min || ''} by=${req.session.os.user.name}`);
    res.json(data);
  } catch (e) { next(e); }
});

router.delete('/security-group-rules/:id', async (req, res, next) => {
  try {
    const sess = req.session.os;
    const rule = await fetchOwned(sess, 'network', `/v2.0/security-group-rules/${req.params.id}`, 'security_group_rule');
    await fetchOwned(sess, 'network', `/v2.0/security-groups/${rule.security_group_id}`, 'security_group');
    await osFetch(req.session.os, 'network', `/v2.0/security-group-rules/${req.params.id}`, { method: 'DELETE' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
