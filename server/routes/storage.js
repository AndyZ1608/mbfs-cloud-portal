import { Router } from 'express';
import { osFetch, OSError, MOCK } from '../openstack.js';
import { fetchOwned, isUsableImage, owned } from '../projectScope.js';

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
    await fetchOwned(req.session.os, 'volume', `/volumes/${req.params.id}`, 'volume');
    const { new_size } = req.body || {};
    if (!new_size) throw new OSError(400, 'Thiếu dung lượng mới');
    await osFetch(req.session.os, 'volume', `/volumes/${req.params.id}/action`, { method: 'POST', body: { 'os-extend': { new_size: Number(new_size) } } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Gắn / tháo volume (gọi qua Nova)
router.post('/volumes/:id/attach', async (req, res, next) => {
  try {
    const { server_id } = req.body || {};
    if (!server_id) throw new OSError(400, 'Chưa chọn máy ảo');
    await fetchOwned(req.session.os, 'volume', `/volumes/${req.params.id}`, 'volume');
    await fetchOwned(req.session.os, 'compute', `/servers/${server_id}`, 'server');
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
    await fetchOwned(req.session.os, 'compute', `/servers/${server_id}`, 'server');
    if (!volume.attachments?.some((attachment) => attachment.server_id === server_id)) {
      throw new OSError(404, 'Không tìm thấy tài nguyên trong project hiện tại.', 'resource_not_found');
    }
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
    await fetchOwned(req.session.os, 'volume', `/volumes/${volume_id}`, 'volume');
    const data = await osFetch(req.session.os, 'volume', '/snapshots', { method: 'POST', body: { snapshot: { volume_id, name, force: true } } });
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
    const data = await osFetch(sess, 'image', '/v2/images?limit=200&sort=created_at:desc');
    const visible = [];
    for (const image of data.images || []) {
      if (await isUsableImage(sess, image)) visible.push(image);
    }
    res.json({ images: visible });
  } catch (e) { next(e); }
});

// Tạo metadata image (bước 1 của upload)
router.post('/images', async (req, res, next) => {
  try {
    const { name, disk_format, min_disk, min_ram } = req.body || {};
    if (!name || !disk_format) throw new OSError(400, 'Thiếu tên hoặc định dạng image');
    const image = { name, disk_format, container_format: 'bare', visibility: 'private' };
    if (min_disk) image.min_disk = Number(min_disk);
    if (min_ram) image.min_ram = Number(min_ram);
    const data = await osFetch(req.session.os, 'image', '/v2/images', { method: 'POST', body: image });
    console.log(`[image] CREATE image name=${name} format=${disk_format} by=${req.session.os.user.name}`);
    res.json({ image: data });
  } catch (e) { next(e); }
});

// Upload dữ liệu image (bước 2) — stream thẳng browser → portal → Glance, không buffer
router.put('/images/:id/file', async (req, res, next) => {
  try {
    const sess = req.session.os;
    await ownedImage(sess, req.params.id);
    if (MOCK) {
      let size = 0;
      for await (const chunk of req) size += chunk.length;
      await osFetch(sess, 'image', `/v2/images/${req.params.id}/file`, { method: 'PUT', body: { size } });
    } else {
      await osFetch(sess, 'image', `/v2/images/${req.params.id}/file`, { method: 'PUT', rawBody: req });
    }
    console.log(`[image] UPLOAD image=${req.params.id} by=${sess.user.name}`);
    res.json({ ok: true });
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
