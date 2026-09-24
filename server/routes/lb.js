// lb.js — Octavia Load Balancer (service type: load-balancer)
import { Router } from 'express';
import { osFetch, OSError, MOCK, endpointFor } from '../openstack.js';
import { fetchOwned, fetchUsableSubnet, isOwned, owned, projectQuery } from '../projectScope.js';

const router = Router();

// Cụm có deploy Octavia không? (dựa vào service catalog)
router.get('/lb/available', (req, res) => {
  if (MOCK) return res.json({ available: true });
  try { endpointFor(req.session.os.catalog, 'lb'); res.json({ available: true }); }
  catch { res.json({ available: false }); }
});

router.get('/lb', async (req, res, next) => {
  try {
    const sess = req.session.os;
    const data = await osFetch(sess, 'lb', projectQuery(sess, '/v2/lbaas/loadbalancers'));
    res.json({ loadbalancers: owned(data.loadbalancers, sess) });
  } catch (e) { next(e); }
});

// Cây chi tiết: LB → listeners → pool (members + healthmonitor)
router.get('/lb/:id/tree', async (req, res, next) => {
  try {
    const sess = req.session.os;
    const loadbalancer = await fetchOwned(sess, 'lb', `/v2/lbaas/loadbalancers/${req.params.id}`, 'loadbalancer');
    const [lisR, poolR] = await Promise.all([
      osFetch(sess, 'lb', `/v2/lbaas/listeners?load_balancer_id=${req.params.id}`),
      osFetch(sess, 'lb', `/v2/lbaas/pools?loadbalancer_id=${req.params.id}`),
    ]);
    const pools = owned(poolR.pools, sess).filter((pool) => pool.loadbalancers?.some((ref) => ref.id === loadbalancer.id));
    await Promise.all(pools.map(async (p) => {
      const mem = await osFetch(sess, 'lb', `/v2/lbaas/pools/${p.id}/members`);
      p.members = (mem.members || []).filter((member) => !member.project_id && !member.tenant_id || isOwned(member, sess));
      if (p.healthmonitor_id) {
        try {
          const monitor = (await osFetch(sess, 'lb', `/v2/lbaas/healthmonitors/${p.healthmonitor_id}`)).healthmonitor;
          p.healthmonitor = monitor && (!monitor.project_id && !monitor.tenant_id || isOwned(monitor, sess)) ? monitor : null;
        }
        catch { p.healthmonitor = null; }
      }
    }));
    const listeners = (lisR.listeners || []).filter((listener) => listener.loadbalancer_id === loadbalancer.id && isOwned(listener, sess))
      .map((l) => ({ ...l, pool: pools.find((p) => p.id === l.default_pool_id) || null }));
    res.json({ loadbalancer, listeners });
  } catch (e) { next(e); }
});

// Resolve server → {address, subnet_id} từ port đầu tiên của máy
async function memberFromServer(sess, server_id, port) {
  await fetchOwned(sess, 'compute', `/servers/${server_id}`, 'server');
  const pr = await osFetch(sess, 'network', `/v2.0/ports?device_id=${server_id}`);
  const fx = owned(pr.ports, sess)[0]?.fixed_ips?.[0];
  if (!fx) throw new OSError(400, `Máy ảo ${server_id} không có port mạng nào`);
  return { address: fx.ip_address, subnet_id: fx.subnet_id, protocol_port: Number(port) };
}

// Tạo LB fully-populated (1 call dựng cả cây: listener + pool + members + monitor)
router.post('/lb', async (req, res, next) => {
  try {
    const sess = req.session.os;
    const { name, subnet_id, protocol = 'HTTP', port = 80, algorithm = 'ROUND_ROBIN', members = [], monitor } = req.body || {};
    if (!name || !subnet_id) throw new OSError(400, 'Thiếu tên hoặc subnet cho VIP');
    if (!members.length) throw new OSError(400, 'Chọn ít nhất một máy ảo backend');
    await fetchUsableSubnet(sess, subnet_id);

    const resolved = [];
    for (const m of members) {
      const r = await memberFromServer(sess, m.server_id, m.port || port);
      resolved.push({ ...r, name: m.name });
    }

    const pool = {
      name: `${name}-pool`,
      protocol: protocol === 'HTTPS' ? 'TCP' : protocol, // HTTPS passthrough = TCP ở pool
      lb_algorithm: algorithm,
      members: resolved,
    };
    if (monitor?.enabled) {
      pool.healthmonitor = {
        type: monitor.type || (protocol === 'HTTP' ? 'HTTP' : 'TCP'),
        delay: Number(monitor.delay) || 5,
        timeout: Number(monitor.timeout) || 5,
        max_retries: Number(monitor.retries) || 3,
        ...(protocol === 'HTTP' ? { url_path: monitor.path || '/' } : {}),
      };
    }
    const body = {
      loadbalancer: {
        name,
        project_id: sess.project.id,
        vip_subnet_id: subnet_id,
        listeners: [{
          name: `${name}-listener`,
          protocol: protocol === 'HTTPS' ? 'TCP' : protocol,
          protocol_port: Number(port),
          default_pool: pool,
        }],
      },
    };
    const data = await osFetch(sess, 'lb', '/v2/lbaas/loadbalancers', { method: 'POST', body });
    console.log(`[lb] CREATE lb name=${name} members=${resolved.length} by=${sess.user.name}`);
    res.status(202).json(data);
  } catch (e) { next(e); }
});

router.post('/lb/pools/:pid/members', async (req, res, next) => {
  try {
    const sess = req.session.os;
    const { server_id, port } = req.body || {};
    if (!server_id || !port) throw new OSError(400, 'Thiếu máy ảo hoặc cổng backend');
    const pool = await fetchOwned(sess, 'lb', `/v2/lbaas/pools/${req.params.pid}`, 'pool');
    const parentId = pool.loadbalancers?.[0]?.id;
    if (!parentId) throw new OSError(404, 'Không tìm thấy tài nguyên trong project hiện tại.', 'resource_not_found');
    await fetchOwned(sess, 'lb', `/v2/lbaas/loadbalancers/${parentId}`, 'loadbalancer');
    const member = await memberFromServer(sess, server_id, port);
    const data = await osFetch(sess, 'lb', `/v2/lbaas/pools/${req.params.pid}/members`, { method: 'POST', body: { member } });
    console.log(`[lb] ADD member pool=${req.params.pid} addr=${member.address}:${port} by=${sess.user.name}`);
    res.json(data);
  } catch (e) { next(e); }
});

router.delete('/lb/pools/:pid/members/:mid', async (req, res, next) => {
  try {
    const sess = req.session.os;
    const pool = await fetchOwned(sess, 'lb', `/v2/lbaas/pools/${req.params.pid}`, 'pool');
    const parentId = pool.loadbalancers?.[0]?.id;
    if (!parentId) throw new OSError(404, 'Không tìm thấy tài nguyên trong project hiện tại.', 'resource_not_found');
    await fetchOwned(sess, 'lb', `/v2/lbaas/loadbalancers/${parentId}`, 'loadbalancer');
    const member = (await osFetch(sess, 'lb', `/v2/lbaas/pools/${req.params.pid}/members/${req.params.mid}`))?.member;
    if (!member || member.project_id && !owned([member], sess).length) {
      throw new OSError(404, 'Không tìm thấy tài nguyên trong project hiện tại.', 'resource_not_found');
    }
    await osFetch(req.session.os, 'lb', `/v2/lbaas/pools/${req.params.pid}/members/${req.params.mid}`, { method: 'DELETE' });
    console.log(`[lb] DEL member pool=${req.params.pid} member=${req.params.mid} by=${req.session.os.user.name}`);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/lb/:id', async (req, res, next) => {
  try {
    await fetchOwned(req.session.os, 'lb', `/v2/lbaas/loadbalancers/${req.params.id}`, 'loadbalancer');
    await osFetch(req.session.os, 'lb', `/v2/lbaas/loadbalancers/${req.params.id}?cascade=true`, { method: 'DELETE' });
    console.log(`[lb] DELETE lb=${req.params.id} (cascade) by=${req.session.os.user.name}`);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
