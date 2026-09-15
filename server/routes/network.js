import { Router } from 'express';
import { osFetch, OSError } from '../openstack.js';

const router = Router();

// ---------- Networks + Subnets ----------

router.get('/networks', async (req, res, next) => {
  try {
    const sess = req.session.os;
    const [nets, subs] = await Promise.all([
      osFetch(sess, 'network', '/v2.0/networks'),
      osFetch(sess, 'network', '/v2.0/subnets'),
    ]);
    const subMap = {};
    (subs.subnets || []).forEach((s) => (subMap[s.id] = s));
    const networks = (nets.networks || []).map((n) => ({
      ...n,
      subnet_details: (n.subnets || []).map((id) => subMap[id]).filter(Boolean),
    }));
    res.json({ networks });
  } catch (e) { next(e); }
});

router.get('/external-networks', async (req, res, next) => {
  try {
    const data = await osFetch(req.session.os, 'network', '/v2.0/networks?router:external=true');
    res.json({ networks: data.networks || [] });
  } catch (e) { next(e); }
});

// Tạo network + subnet trong một bước (rollback network nếu subnet lỗi)
router.post('/networks', async (req, res, next) => {
  const sess = req.session.os;
  try {
    const { name, cidr, gateway_ip, enable_dhcp = true, dns } = req.body || {};
    if (!name || !cidr) throw new OSError(400, 'Thiếu tên network hoặc CIDR');
    const net = await osFetch(sess, 'network', '/v2.0/networks', { method: 'POST', body: { network: { name } } });
    try {
      const subnet = { network_id: net.network.id, name: `${name}-subnet`, cidr, ip_version: 4, enable_dhcp: !!enable_dhcp };
      if (gateway_ip) subnet.gateway_ip = gateway_ip;
      if (dns) subnet.dns_nameservers = String(dns).split(',').map((s) => s.trim()).filter(Boolean);
      const sub = await osFetch(sess, 'network', '/v2.0/subnets', { method: 'POST', body: { subnet } });
      console.log(`[network] CREATE network name=${name} cidr=${cidr} by=${sess.user.name}`);
      res.json({ network: { ...net.network, subnet_details: [sub.subnet] }, subnet: sub.subnet });
    } catch (e) {
      await osFetch(sess, 'network', `/v2.0/networks/${net.network.id}`, { method: 'DELETE' }).catch(() => {});
      throw e;
    }
  } catch (e) { next(e); }
});

router.delete('/networks/:id', async (req, res, next) => {
  try {
    await osFetch(req.session.os, 'network', `/v2.0/networks/${req.params.id}`, { method: 'DELETE' });
    console.log(`[network] DELETE network=${req.params.id} by=${req.session.os.user.name}`);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- Ports ----------

router.get('/ports', async (req, res, next) => {
  try {
    const dev = req.query.device_id;
    const path = dev ? `/v2.0/ports?device_id=${encodeURIComponent(dev)}` : '/v2.0/ports';
    const data = await osFetch(req.session.os, 'network', path);
    res.json(data);
  } catch (e) { next(e); }
});

// ---------- Routers ----------

router.get('/routers', async (req, res, next) => {
  try {
    const data = await osFetch(req.session.os, 'network', '/v2.0/routers');
    res.json({ routers: data.routers || [] });
  } catch (e) { next(e); }
});

router.post('/routers', async (req, res, next) => {
  try {
    const { name, external_network_id } = req.body || {};
    if (!name) throw new OSError(400, 'Thiếu tên router');
    const body = { router: { name } };
    if (external_network_id) body.router.external_gateway_info = { network_id: external_network_id };
    const data = await osFetch(req.session.os, 'network', '/v2.0/routers', { method: 'POST', body });
    console.log(`[network] CREATE router name=${name} by=${req.session.os.user.name}`);
    res.json(data);
  } catch (e) { next(e); }
});

router.get('/routers/:id/interfaces', async (req, res, next) => {
  try {
    const data = await osFetch(req.session.os, 'network', `/v2.0/ports?device_id=${req.params.id}`);
    const ifaces = (data.ports || []).filter((p) => (p.device_owner || '').includes('router_interface') || (p.device_owner || '') === 'network:ha_router_replicated_interface');
    res.json({ interfaces: ifaces });
  } catch (e) { next(e); }
});

router.post('/routers/:id/interfaces', async (req, res, next) => {
  try {
    const { subnet_id } = req.body || {};
    if (!subnet_id) throw new OSError(400, 'Thiếu subnet_id');
    const data = await osFetch(req.session.os, 'network', `/v2.0/routers/${req.params.id}/add_router_interface`, { method: 'PUT', body: { subnet_id } });
    res.json(data);
  } catch (e) { next(e); }
});

router.delete('/routers/:id/interfaces/:subnetId', async (req, res, next) => {
  try {
    const data = await osFetch(req.session.os, 'network', `/v2.0/routers/${req.params.id}/remove_router_interface`, { method: 'PUT', body: { subnet_id: req.params.subnetId } });
    res.json(data || { ok: true });
  } catch (e) { next(e); }
});

router.delete('/routers/:id', async (req, res, next) => {
  try {
    await osFetch(req.session.os, 'network', `/v2.0/routers/${req.params.id}`, { method: 'DELETE' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- Floating IPs ----------

// Danh sách FIP, kèm tên máy ảo đang gắn (nếu có)
router.get('/floatingips', async (req, res, next) => {
  try {
    const sess = req.session.os;
    const data = await osFetch(sess, 'network', '/v2.0/floatingips');
    const fips = data.floatingips || [];
    const portIds = fips.filter((f) => f.port_id).map((f) => f.port_id);
    let portMap = {};
    if (portIds.length) {
      const qs = portIds.map((id) => `id=${encodeURIComponent(id)}`).join('&');
      const pr = await osFetch(sess, 'network', `/v2.0/ports?${qs}`).catch(() => ({ ports: [] }));
      (pr.ports || []).forEach((p) => (portMap[p.id] = p));
    }
    let serverMap = {};
    if (Object.values(portMap).some((p) => (p.device_owner || '').startsWith('compute'))) {
      const sv = await osFetch(sess, 'compute', '/servers/detail').catch(() => ({ servers: [] }));
      (sv.servers || []).forEach((s) => (serverMap[s.id] = s.name));
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
    const data = await osFetch(req.session.os, 'network', '/v2.0/floatingips', { method: 'POST', body: { floatingip: { floating_network_id } } });
    console.log(`[network] ALLOCATE fip=${data.floatingip?.floating_ip_address} by=${req.session.os.user.name}`);
    res.json(data);
  } catch (e) { next(e); }
});

// Gắn FIP vào máy ảo: tự tìm port của máy
router.post('/floatingips/:id/associate', async (req, res, next) => {
  try {
    const sess = req.session.os;
    const { server_id, port_id } = req.body || {};
    let portId = port_id;
    if (!portId) {
      if (!server_id) throw new OSError(400, 'Chưa chọn máy ảo hoặc port');
      const pr = await osFetch(sess, 'network', `/v2.0/ports?device_id=${encodeURIComponent(server_id)}`);
      const port = (pr.ports || [])[0];
      if (!port) throw new OSError(404, 'Máy ảo chưa có port mạng (có thể đang khởi tạo)');
      portId = port.id;
    }
    const data = await osFetch(sess, 'network', `/v2.0/floatingips/${req.params.id}`, { method: 'PUT', body: { floatingip: { port_id: portId } } });
    console.log(`[network] ASSOCIATE fip=${req.params.id} -> ${server_id ? 'server=' + server_id : 'port=' + portId} by=${sess.user.name}`);
    res.json(data);
  } catch (e) { next(e); }
});

router.post('/floatingips/:id/disassociate', async (req, res, next) => {
  try {
    const data = await osFetch(req.session.os, 'network', `/v2.0/floatingips/${req.params.id}`, { method: 'PUT', body: { floatingip: { port_id: null } } });
    res.json(data);
  } catch (e) { next(e); }
});

router.delete('/floatingips/:id', async (req, res, next) => {
  try {
    await osFetch(req.session.os, 'network', `/v2.0/floatingips/${req.params.id}`, { method: 'DELETE' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- Security Groups ----------

router.get('/security-groups', async (req, res, next) => {
  try {
    const data = await osFetch(req.session.os, 'network', '/v2.0/security-groups');
    res.json({ security_groups: data.security_groups || [] });
  } catch (e) { next(e); }
});

router.post('/security-groups', async (req, res, next) => {
  try {
    const { name, description } = req.body || {};
    if (!name) throw new OSError(400, 'Thiếu tên security group');
    const data = await osFetch(req.session.os, 'network', '/v2.0/security-groups', { method: 'POST', body: { security_group: { name, description: description || '' } } });
    console.log(`[network] CREATE secgroup name=${name} by=${req.session.os.user.name}`);
    res.json(data);
  } catch (e) { next(e); }
});

router.delete('/security-groups/:id', async (req, res, next) => {
  try {
    await osFetch(req.session.os, 'network', `/v2.0/security-groups/${req.params.id}`, { method: 'DELETE' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/security-group-rules', async (req, res, next) => {
  try {
    const { security_group_id, direction, protocol, port_min, port_max, remote_ip_prefix } = req.body || {};
    if (!security_group_id || !direction) throw new OSError(400, 'Thiếu thông tin rule');
    const rule = { security_group_id, direction, ethertype: 'IPv4' };
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
    await osFetch(req.session.os, 'network', `/v2.0/security-group-rules/${req.params.id}`, { method: 'DELETE' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
