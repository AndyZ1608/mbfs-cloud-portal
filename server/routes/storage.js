import { Router } from 'express';
import { osFetch, OSError } from '../openstack.js';
import { fetchOwned, isUsableImage, owned } from '../projectScope.js';
import { setInstanceAudit, setVolumeAudit } from '../audit.js';
import { requestVolumeExtend } from '../volumeExtend.js';
import { decodeUploadHeader, uploadImage } from '../imageUpload.js';

const router = Router();

async function ownedImage(session, id) {
  const image = await osFetch(session, 'image', `/v2/images/${id}`);
  if (image?.owner !== session.project.id) {
    throw new OSError(404, 'Không tìm thấy tài nguyên trong project hiện tại.', 'resource_not_found');
  }
  return image;
}

// ---------- Volumes (Cinder) ----------

router.get('/volumes', async (req, res, next) => {
  try {
    const data = await osFetch(req.session.os, 'volume', '/volumes/detail');
    res.json({ volumes: owned(data.volumes, req.session.os) });
  } catch (e) { next(e); }
});

router.post('/volumes', async (req, res, next) => {
  try {
    const { name, size, volume_type, description } = req.body || {};
    if (!size || Number(size) < 1) throw new OSError(400, 'Dung lượng (GB) không hợp lệ');
    const volume = { size: Number(size), name: name || '' };
    if (volume_type) volume.volume_type = volume_type;
    if (description) volume.description = description;
    const data = await osFetch(req.session.os, 'volume', '/volumes', { method: 'POST', body: { volume } });
    console.log(`[volume] CREATE name=${name} size=${size}GB by=${req.session.os.user.name}`);
    res.json(data);
  } catch (e) { next(e); }
});

router.delete('/volumes/:id', async (req, res, next) => {
  try {
    await fetchOwned(req.session.os, 'volume', `/volumes/${req.params.id}`, 'volume');
    await osFetch(req.session.os, 'volume', `/volumes/${req.params.id}`, { method: 'DELETE' });
    console.log(`[volume] DELETE volume=${req.params.id} by=${req.session.os.user.name}`);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/volumes/:id/extend', async (req, res, next) => {
  try {
    const volume = await fetchOwned(req.session.os, 'volume', `/volumes/${req.params.id}`, 'volume');
    const newSize = req.body?.new_size;
    const oldSize = volume.size;
    const wasAttached = volume.status === 'in-use';
    const result = await requestVolumeExtend(req.session.os, volume, newSize);
    setVolumeAudit(res, { action: 'volume.extend.request', resourceId: volume.id, resourceName: volume.name,
      details: { volume_id: volume.id, old_size_gb: oldSize, new_size_gb: newSize, attached: wasAttached } });
    res.status(202).json(result);
  } catch (e) { next(e); }
});

// Gắn / tháo volume (gọi qua Nova)
router.post('/volumes/:id/attach', async (req, res, next) => {
  try {
    const { server_id } = req.body || {};
    if (!server_id) throw new OSError(400, 'Chưa chọn máy ảo');
    const volume = await fetchOwned(req.session.os, 'volume', `/volumes/${req.params.id}`, 'volume');
    const server = await fetchOwned(req.session.os, 'compute', `/servers/${server_id}`, 'server');
    setInstanceAudit(res, { action: 'instance.volume.attach', resourceId: server.id,
      resourceName: server.name, result: 'accepted',
      details: { volume_id: volume.id, volume_name: volume.name || null } });
    const data = await osFetch(req.session.os, 'compute', `/servers/${server_id}/os-volume_attachments`, {
      method: 'POST',
      body: { volumeAttachment: { volumeId: req.params.id } },
    });
    console.log(`[volume] ATTACH volume=${req.params.id} -> server=${server_id} by=${req.session.os.user.name}`);
    res.json(data);
  } catch (e) { next(e); }
});

router.post('/volumes/:id/detach', async (req, res, next) => {
  try {
    const { server_id } = req.body || {};
    if (!server_id) throw new OSError(400, 'Thiếu server_id');
    const volume = await fetchOwned(req.session.os, 'volume', `/volumes/${req.params.id}`, 'volume');
    const server = await fetchOwned(req.session.os, 'compute', `/servers/${server_id}`, 'server');
    if (!volume.attachments?.some((attachment) => attachment.server_id === server_id)) {
      throw new OSError(404, 'Không tìm thấy tài nguyên trong project hiện tại.', 'resource_not_found');
    }
    setInstanceAudit(res, { action: 'instance.volume.detach', resourceId: server.id,
      resourceName: server.name, result: 'accepted',
      details: { volume_id: volume.id, volume_name: volume.name || null,
        device: volume.attachments.find((item) => item.server_id === server_id)?.device || null } });
    await osFetch(req.session.os, 'compute', `/servers/${server_id}/os-volume_attachments/${req.params.id}`, { method: 'DELETE' });
    console.log(`[volume] DETACH volume=${req.params.id} <- server=${server_id} by=${req.session.os.user.name}`);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/volume-types', async (req, res, next) => {
  try {
    const data = await osFetch(req.session.os, 'volume', '/types');
    res.json({ volume_types: data.volume_types || [] });
  } catch (e) { next(e); }
});

// ---------- Snapshots ----------

router.get('/snapshots', async (req, res, next) => {
  try {
    const data = await osFetch(req.session.os, 'volume', '/snapshots/detail');
    res.json({ snapshots: owned(data.snapshots, req.session.os) });
  } catch (e) { next(e); }
});

router.post('/snapshots', async (req, res, next) => {
  try {
    const { volume_id, name } = req.body || {};
    if (!volume_id || !name) throw new OSError(400, 'Thiếu volume hoặc tên snapshot');
    const volume = await fetchOwned(req.session.os, 'volume', `/volumes/${volume_id}`, 'volume');
    const servers = [...new Set((volume.attachments || []).map((item) => item.server_id).filter(Boolean))];
    const server = servers.length === 1
      ? await fetchOwned(req.session.os, 'compute', `/servers/${servers[0]}`, 'server').catch(() => null) : null;
    if (server) setInstanceAudit(res, { action: 'instance.snapshot.create',
      resourceId: server.id, resourceName: server.name, result: 'accepted',
      details: { snapshot_name: name, volume_id: volume.id } });
    const data = await osFetch(req.session.os, 'volume', '/snapshots', { method: 'POST', body: { snapshot: { volume_id, name, force: true } } });
    if (server && data?.snapshot?.id) res.locals.instanceAudit.details.snapshot_id = data.snapshot.id;
    console.log(`[volume] SNAPSHOT volume=${volume_id} name=${name} by=${req.session.os.user.name}`);
    res.json(data);
  } catch (e) { next(e); }
});

router.delete('/snapshots/:id', async (req, res, next) => {
  try {
    await fetchOwned(req.session.os, 'volume', `/snapshots/${req.params.id}`, 'snapshot');
    await osFetch(req.session.os, 'volume', `/snapshots/${req.params.id}`, { method: 'DELETE' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- Images (Glance) ----------

router.get('/images', async (req, res, next) => {
  try {
    const sess = req.session.os;
    let path = '/v2/images?limit=200&sort=created_at:desc';
    const seen = new Set();
    const visible = [];
    while (path) {
      if (seen.has(path)) throw new OSError(502, 'Glance image catalog pagination loop');
      seen.add(path);
      const data = await osFetch(sess, 'image', path);
      for (const image of data.images || []) {
        if (await isUsableImage(sess, image)) visible.push(image);
      }
      if (!data.next) break;
      const next = new URL(data.next, 'http://glance.invalid');
      if (!next.pathname.endsWith('/v2/images')) throw new OSError(502, 'Invalid Glance image catalog pagination path');
      path = '/v2/images' + next.search;
    }
    res.json({ images: visible });
  } catch (e) { next(e); }
});

// One request owns Glance metadata, the streamed binary PUT, and status verification.
router.post('/images/upload', async (req, res, next) => {
  try {
    const sess = { ...req.session.os, project: { ...req.session.os.project } };
    const filename = decodeUploadHeader(req.get('x-image-filename'));
    const name = decodeUploadHeader(req.get('x-image-name'));
    const result = await uploadImage(sess, { filename, name,
      minDisk: req.get('x-image-min-disk'), minRam: req.get('x-image-min-ram'),
      source: req, contentLength: req.get('content-length') }, {
      onStage(stage, details = {}) {
        console.log(`[image] stage=${stage} request_id=${req.id} project=${sess.project.id} image=${details.imageId || '-'} format=${details.diskFormat || '-'} bytes=${details.bytes ?? '-'} status=${details.status ?? '-'}`);
      },
    });
    res.status(result.processing ? 202 : 200).json(result);
  } catch (e) { next(e); }
});

router.delete('/images/:id', async (req, res, next) => {
  try {
    await ownedImage(req.session.os, req.params.id);
    await osFetch(req.session.os, 'image', `/v2/images/${req.params.id}`, { method: 'DELETE' });
    console.log(`[image] DELETE image=${req.params.id} by=${req.session.os.user.name}`);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
