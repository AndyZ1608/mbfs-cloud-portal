import { Router } from 'express';
import { osFetch, OSError } from '../openstack.js';

const router = Router();

// ---------- Servers ----------

router.get('/servers', async (req, res, next) => {
  try {
    const data = await osFetch(req.session.os, 'compute', '/servers/detail');
    res.json({ servers: data.servers || [] });
  } catch (e) { next(e); }
});

router.post('/servers', async (req, res, next) => {
  try {
    const { name, flavorRef, imageRef, networks, key_name, security_groups, count, boot_volume_gb, user_data } = req.body || {};
    if (!name || !flavorRef || !imageRef || !networks?.length) {
      throw new OSError(400, 'Thiếu thông tin: tên, flavor, image và ít nhất một network là bắt buộc');
    }
    const server = {
      name,
      flavorRef,
      networks: networks.map((uuid) => ({ uuid })),
    };
    if (boot_volume_gb && Number(boot_volume_gb) > 0) {
      server.block_device_mapping_v2 = [{
        boot_index: 0,
        uuid: imageRef,
        source_type: 'image',
        destination_type: 'volume',
        volume_size: Number(boot_volume_gb),
        delete_on_termination: true,
      }];
    } else {
      server.imageRef = imageRef;
    }
    if (key_name) server.key_name = key_name;
    if (security_groups?.length) server.security_groups = security_groups.map((n) => ({ name: n }));
    const n = Math.max(1, Math.min(Number(count) || 1, 10));
    if (n > 1) { server.min_count = n; server.max_count = n; }
    if (user_data && String(user_data).trim()) {
      if (String(user_data).length > 60000) throw new OSError(400, 'user-data quá dài (tối đa ~60KB)');
      server.user_data = Buffer.from(String(user_data)).toString('base64');
    }

    const data = await osFetch(req.session.os, 'compute', '/servers', { method: 'POST', body: { server } });
    console.log(`[compute] CREATE server name=${name} x${n} by=${req.session.os.user.name}`);
    res.status(202).json(data);
  } catch (e) { next(e); }
});

router.get('/servers/:id', async (req, res, next) => {
  try {
    const data = await osFetch(req.session.os, 'compute', `/servers/${req.params.id}`);
    res.json(data);
  } catch (e) { next(e); }
});

const ACTIONS = {
  start: { 'os-start': null },
  stop: { 'os-stop': null },
  'reboot-soft': { reboot: { type: 'SOFT' } },
  'reboot-hard': { reboot: { type: 'HARD' } },
  pause: { pause: null },
  unpause: { unpause: null },
  'confirm-resize': { confirmResize: null },
  'revert-resize': { revertResize: null },
  shelve: { shelve: null },
  unshelve: { unshelve: null },
};

// Đổi tên máy ảo
router.put('/servers/:id', async (req, res, next) => {
  try {
    const name = (req.body?.name || '').trim();
    if (!name) throw new OSError(400, 'Tên mới không được trống');
    const data = await osFetch(req.session.os, 'compute', `/servers/${req.params.id}`, {
      method: 'PUT', body: { server: { name } },
    });
    console.log(`[compute] RENAME server=${req.params.id} -> ${name} by=${req.session.os.user.name}`);
    res.json(data);
  } catch (e) { next(e); }
});

// Cài lại hệ điều hành (rebuild) — giữ nguyên IP, ID máy, volume gắn kèm
router.post('/servers/:id/rebuild', async (req, res, next) => {
  try {
    const { imageRef, name, user_data } = req.body || {};
    if (!imageRef) throw new OSError(400, 'Chọn image để cài lại');
    const rebuild = { imageRef };
    if (name) rebuild.name = name;
    if (user_data && String(user_data).trim()) rebuild.user_data = Buffer.from(String(user_data)).toString('base64');
    await osFetch(req.session.os, 'compute', `/servers/${req.params.id}/action`, { method: 'POST', body: { rebuild } });
    console.log(`[compute] REBUILD server=${req.params.id} image=${imageRef} by=${req.session.os.user.name}`);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Card mạng (NIC) của máy ảo
router.get('/servers/:id/interfaces', async (req, res, next) => {
  try {
    const d = await osFetch(req.session.os, 'compute', `/servers/${req.params.id}/os-interface`);
    res.json({ interfaces: d.interfaceAttachments || [] });
  } catch (e) { next(e); }
});

router.post('/servers/:id/interfaces', async (req, res, next) => {
  try {
    const { net_id } = req.body || {};
    if (!net_id) throw new OSError(400, 'Chọn network để gắn');
    const d = await osFetch(req.session.os, 'compute', `/servers/${req.params.id}/os-interface`, {
      method: 'POST', body: { interfaceAttachment: { net_id } },
    });
    console.log(`[compute] ATTACH nic server=${req.params.id} net=${net_id} by=${req.session.os.user.name}`);
    res.json(d);
  } catch (e) { next(e); }
});

router.delete('/servers/:id/interfaces/:portId', async (req, res, next) => {
  try {
    await osFetch(req.session.os, 'compute', `/servers/${req.params.id}/os-interface/${req.params.portId}`, { method: 'DELETE' });
    console.log(`[compute] DETACH nic server=${req.params.id} port=${req.params.portId} by=${req.session.os.user.name}`);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Đổi security group của máy đang chạy
router.post('/servers/:id/security-groups', async (req, res, next) => {
  try {
    const { add = [], remove = [] } = req.body || {};
    for (const name of remove) {
      await osFetch(req.session.os, 'compute', `/servers/${req.params.id}/action`, { method: 'POST', body: { removeSecurityGroup: { name } } });
    }
    for (const name of add) {
      await osFetch(req.session.os, 'compute', `/servers/${req.params.id}/action`, { method: 'POST', body: { addSecurityGroup: { name } } });
    }
    console.log(`[compute] SG server=${req.params.id} +${add.join(',')} -${remove.join(',')} by=${req.session.os.user.name}`);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/servers/:id/action', async (req, res, next) => {
  try {
    const { action, name, flavorRef } = req.body || {};
    let body;
    if (action === 'snapshot') {
      if (!name) throw new OSError(400, 'Thiếu tên snapshot');
      body = { createImage: { name } };
    } else if (action === 'resize') {
      if (!flavorRef) throw new OSError(400, 'Thiếu flavor mới để resize');
      body = { resize: { flavorRef } };
    } else {
      body = ACTIONS[action];
      if (!body) throw new OSError(400, `Hành động không hợp lệ: ${action}`);
    }
    const data = await osFetch(req.session.os, 'compute', `/servers/${req.params.id}/action`, { method: 'POST', body });
    console.log(`[compute] ACTION ${action} server=${req.params.id} by=${req.session.os.user.name}`);
    res.json(data || { ok: true });
  } catch (e) { next(e); }
});

router.delete('/servers/:id', async (req, res, next) => {
  try {
    await osFetch(req.session.os, 'compute', `/servers/${req.params.id}`, { method: 'DELETE' });
    console.log(`[compute] DELETE server=${req.params.id} by=${req.session.os.user.name}`);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/servers/:id/console', async (req, res, next) => {
  try {
    const data = await osFetch(req.session.os, 'compute', `/servers/${req.params.id}/remote-consoles`, {
      method: 'POST',
      body: { remote_console: { protocol: 'vnc', type: 'novnc' } },
    });
    res.json(data);
  } catch (e) { next(e); }
});

// Log console của máy ảo (boot log / cloud-init) — hữu ích khi VM không SSH được
router.get('/servers/:id/console-log', async (req, res, next) => {
  try {
    const length = Math.min(Number(req.query.lines) || 300, 2000);
    const data = await osFetch(req.session.os, 'compute', `/servers/${req.params.id}/action`, {
      method: 'POST',
      body: { 'os-getConsoleOutput': { length } },
    });
    res.json({ output: data?.output ?? '' });
  } catch (e) { next(e); }
});

// ---------- Báo cáo sử dụng (os-simple-tenant-usage) ----------

router.get('/usage', async (req, res, next) => {
  try {
    const sess = req.session.os;
    const { start, end } = req.query;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(end || '')) {
      throw new OSError(400, 'start/end phải theo định dạng YYYY-MM-DD');
    }
    const qs = `start=${start}T00:00:00&end=${end}T23:59:59&detailed=1`;
    const data = await osFetch(sess, 'compute', `/os-simple-tenant-usage/${sess.project.id}?${qs}`);
    const u = data?.tenant_usage || {};
    res.json({
      usage: {
        server_usages: u.server_usages || [],
        total_hours: u.total_hours || 0,
        total_vcpus_usage: u.total_vcpus_usage || 0,
        total_memory_mb_usage: u.total_memory_mb_usage || 0,
        total_local_gb_usage: u.total_local_gb_usage || 0,
      },
    });
  } catch (e) { next(e); }
});

// Volume attachments (Nova side)
router.get('/servers/:id/volumes', async (req, res, next) => {
  try {
    const data = await osFetch(req.session.os, 'compute', `/servers/${req.params.id}/os-volume_attachments`);
    res.json(data);
  } catch (e) { next(e); }
});

// ---------- Flavors / Keypairs ----------

router.get('/flavors', async (req, res, next) => {
  try {
    const data = await osFetch(req.session.os, 'compute', '/flavors/detail');
    res.json({ flavors: (data.flavors || []).sort((a, b) => (a.vcpus - b.vcpus) || (a.ram - b.ram)) });
  } catch (e) { next(e); }
});

router.get('/keypairs', async (req, res, next) => {
  try {
    const data = await osFetch(req.session.os, 'compute', '/os-keypairs');
    res.json({ keypairs: (data.keypairs || []).map((k) => k.keypair) });
  } catch (e) { next(e); }
});

router.post('/keypairs', async (req, res, next) => {
  try {
    const { name, public_key } = req.body || {};
    if (!name) throw new OSError(400, 'Thiếu tên keypair');
    const keypair = { name };
    if (public_key) keypair.public_key = public_key;
    const data = await osFetch(req.session.os, 'compute', '/os-keypairs', { method: 'POST', body: { keypair } });
    console.log(`[compute] CREATE keypair name=${name} by=${req.session.os.user.name}`);
    res.json(data);
  } catch (e) { next(e); }
});

router.delete('/keypairs/:name', async (req, res, next) => {
  try {
    await osFetch(req.session.os, 'compute', `/os-keypairs/${encodeURIComponent(req.params.name)}`, { method: 'DELETE' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- Limits (tổng hợp Nova + Cinder + Neutron) ----------

router.get('/limits', async (req, res, next) => {
  try {
    const sess = req.session.os;
    const [nova, cinder, neutron] = await Promise.allSettled([
      osFetch(sess, 'compute', '/limits'),
      osFetch(sess, 'volume', '/limits'),
      osFetch(sess, 'network', `/v2.0/quotas/${sess.project.id}/details.json`),
    ]);
    res.json({
      compute: nova.status === 'fulfilled' ? nova.value?.limits?.absolute || null : null,
      volume: cinder.status === 'fulfilled' ? cinder.value?.limits?.absolute || null : null,
      network: neutron.status === 'fulfilled' ? neutron.value?.quota || null : null,
    });
  } catch (e) { next(e); }
});

export default router;
