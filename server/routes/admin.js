// admin.js — Console quản trị cụm (chỉ user có role admin trên project hiện tại)
// Tổng quan hypervisor · Project + quota (Nova/Cinder/Neutron) · User + gán role.
import { Router } from 'express';
import { osFetch, OSError } from '../openstack.js';
import { requireRole } from '../middleware.js';

const router = Router();

router.use('/admin', requireRole('admin'));

// ---------- Tổng quan cụm ----------
router.get('/admin/overview', async (req, res, next) => {
  try {
    const sess = req.session.os;
    const [hypR, prjR] = await Promise.allSettled([
      osFetch(sess, 'compute', '/os-hypervisors/statistics'),
      osFetch(sess, 'identity', '/v3/projects'),
    ]);
    res.json({
      hypervisors: hypR.status === 'fulfilled' ? hypR.value.hypervisor_statistics : null,
      hypervisors_error: hypR.status === 'rejected' ? String(hypR.reason?.message || hypR.reason) : null,
      projects: prjR.status === 'fulfilled' ? (prjR.value.projects || []).map((p) => ({ id: p.id, name: p.name, enabled: p.enabled, description: p.description })) : [],
    });
  } catch (e) { next(e); }
});

// ---------- Projects + quota ----------
router.post('/admin/projects', async (req, res, next) => {
  try {
    const { name, description = '' } = req.body || {};
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,60}$/.test(name || '')) throw new OSError(400, 'Tên project không hợp lệ');
    const d = await osFetch(req.session.os, 'identity', '/v3/projects', {
      method: 'POST', body: { project: { name, description, domain_id: 'default', enabled: true } },
    });
    console.log(`[admin] CREATE project=${name} by=${req.session.os.user.name}`);
    res.json({ project: d.project });
  } catch (e) { next(e); }
});

router.get('/admin/projects/:id/quota', async (req, res, next) => {
  try {
    const sess = req.session.os;
    const pid = req.params.id;
    const [novaR, cinR, neuR] = await Promise.allSettled([
      osFetch(sess, 'compute', `/os-quota-sets/${pid}`),
      osFetch(sess, 'volume', `/os-quota-sets/${pid}`),
      osFetch(sess, 'network', `/v2.0/quotas/${pid}`),
    ]);
    const nova = novaR.status === 'fulfilled' ? novaR.value.quota_set : {};
    const cin = cinR.status === 'fulfilled' ? cinR.value.quota_set : {};
    const neu = neuR.status === 'fulfilled' ? neuR.value.quota : {};
    res.json({ quota: {
      instances: nova.instances, cores: nova.cores, ram: nova.ram,
      volumes: cin.volumes, gigabytes: cin.gigabytes, snapshots: cin.snapshots,
      floatingip: neu.floatingip, network: neu.network, security_group: neu.security_group,
    } });
  } catch (e) { next(e); }
});

router.put('/admin/projects/:id/quota', async (req, res, next) => {
  try {
    const sess = req.session.os;
    const pid = req.params.id;
    const q = req.body || {};
    const pick = (keys) => Object.fromEntries(keys.filter((k) => q[k] !== undefined && q[k] !== '').map((k) => [k, Number(q[k])]));
    const nova = pick(['instances', 'cores', 'ram']);
    const cin = pick(['volumes', 'gigabytes', 'snapshots']);
    const neu = pick(['floatingip', 'network', 'security_group']);
    const results = [];
    if (Object.keys(nova).length) results.push(osFetch(sess, 'compute', `/os-quota-sets/${pid}`, { method: 'PUT', body: { quota_set: nova } }));
    if (Object.keys(cin).length) results.push(osFetch(sess, 'volume', `/os-quota-sets/${pid}`, { method: 'PUT', body: { quota_set: cin } }));
    if (Object.keys(neu).length) results.push(osFetch(sess, 'network', `/v2.0/quotas/${pid}`, { method: 'PUT', body: { quota: neu } }));
    await Promise.all(results);
    console.log(`[admin] QUOTA project=${pid} ${JSON.stringify({ ...nova, ...cin, ...neu })} by=${sess.user.name}`);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- Users ----------
router.get('/admin/users', async (req, res, next) => {
  try {
    const d = await osFetch(req.session.os, 'identity', '/v3/users');
    res.json({ users: (d.users || []).map((u) => ({ id: u.id, name: u.name, enabled: u.enabled, email: u.email })) });
  } catch (e) { next(e); }
});

router.post('/admin/users', async (req, res, next) => {
  try {
    const { name, password } = req.body || {};
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{1,60}$/.test(name || '')) throw new OSError(400, 'Tên user không hợp lệ');
    if (!password || password.length < 8) throw new OSError(400, 'Mật khẩu tối thiểu 8 ký tự');
    const d = await osFetch(req.session.os, 'identity', '/v3/users', {
      method: 'POST', body: { user: { name, password, domain_id: 'default', enabled: true } },
    });
    console.log(`[admin] CREATE user=${name} by=${req.session.os.user.name}`);
    res.json({ user: { id: d.user.id, name: d.user.name } });
  } catch (e) { next(e); }
});

router.post('/admin/users/:id/password', async (req, res, next) => {
  try {
    const { password } = req.body || {};
    if (!password || password.length < 8) throw new OSError(400, 'Mật khẩu tối thiểu 8 ký tự');
    await osFetch(req.session.os, 'identity', `/v3/users/${req.params.id}`, {
      method: 'PATCH', body: { user: { password } },
    });
    console.log(`[admin] RESET-PASS user=${req.params.id} by=${req.session.os.user.name}`);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Gán role (member/admin) cho user vào project
router.post('/admin/assign', async (req, res, next) => {
  try {
    const sess = req.session.os;
    const { user_id, project_id, role = 'member' } = req.body || {};
    if (!user_id || !project_id) throw new OSError(400, 'Thiếu user hoặc project');
    if (!['member', 'admin'].includes(role)) throw new OSError(400, 'Role phải là member hoặc admin');
    const rr = await osFetch(sess, 'identity', `/v3/roles?name=${role}`);
    const roleId = rr.roles?.[0]?.id;
    if (!roleId) throw new OSError(404, `Không tìm thấy role "${role}" trong Keystone`);
    await osFetch(sess, 'identity', `/v3/projects/${project_id}/users/${user_id}/roles/${roleId}`, { method: 'PUT' });
    console.log(`[admin] ASSIGN user=${user_id} project=${project_id} role=${role} by=${sess.user.name}`);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
