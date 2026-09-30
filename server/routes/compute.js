import { Router } from 'express';
import { osFetch, OSError } from '../openstack.js';
import { traceNovaConsole } from '../consoleDiagnostics.js';
import { changeInstancePassword } from '../passwordChange.js';
import { assertOwned, fetchOwned, fetchUsableImage, owned } from '../projectScope.js';
import { attachInterface, createServerWithInterfaces, prepareInterfaces } from '../instanceInterfaces.js';
import { addInstanceAudit, instanceActionCode, listInstanceAudit, recordInstanceErrorOnce, setInstanceAudit } from '../audit.js';
import { assignmentsForInstances, pruneMissingInstances, removeInstanceAssignments, replaceAssignments, validateSelection } from '../classifications.js';
import { classifyInstanceError, faultImageId, preflightImageFlavor, publicServer, publicServerPayload } from '../instanceErrors.js';
import { deleteInstanceWithPorts } from '../instanceDeletion.js';

const router = Router();

// ---------- Servers ----------

router.get('/servers', async (req, res, next) => {
  try {
    const servers = [];
    let marker = '';
    for (let page = 0; page < 100; page++) {
      const query = new URLSearchParams({ limit: '1000', ...(marker ? { marker } : {}) });
      const data = await osFetch(req.session.os, 'compute', `/servers/detail?${query}`);
      if (!Array.isArray(data.servers)) throw new OSError(502, 'Nova trả về danh sách VM không hợp lệ.', 'provider_failure');
      const batch = data.servers;
      servers.push(...owned(batch, req.session.os));
      if (!batch.length) break;
      const last = batch.at(-1)?.id;
      if (!last || last === marker) throw new OSError(502, 'Nova trả về phân trang VM không hợp lệ.', 'provider_failure');
      if (page === 99) throw new OSError(502, 'Danh sách VM vượt giới hạn phân trang an toàn.', 'provider_failure');
      marker = last;
    }
    const ids = servers.map((item) => item.id);
    const assignments = assignmentsForInstances(req.session.os.project.id, ids);
    pruneMissingInstances(req.session.os.project.id, ids);
    res.json({ servers: servers.map((item) => {
      const instanceError = classifyInstanceError(item);
      if (instanceError) recordInstanceErrorOnce(req.session.os, item, instanceError, req.id);
      return { ...publicServer(item), classification: assignments[item.id],
        ...(instanceError ? { instance_error: { code: instanceError.code, category: instanceError.category } } : {}) };
    }) });
  } catch (e) { next(e); }
});

router.post('/servers', async (req, res, next) => {
  try {
    const sess = req.session.os;
    const { name, flavorRef, imageRef, interfaces, key_name, count, boot_volume_gb, user_data } = req.body || {};
    const classification = req.body?.classification || { labels: [], tag_ids: [] };
    validateSelection(sess.project.id, classification);
    if (!name || !flavorRef || !imageRef) {
      throw new OSError(400, 'Thiếu thông tin: tên, flavor và image là bắt buộc');
    }
    if (boot_volume_gb !== undefined && (!Number.isSafeInteger(Number(boot_volume_gb)) || Number(boot_volume_gb) <= 0)) {
      throw new OSError(400, 'Dung lượng boot volume phải là số GiB nguyên dương.', 'boot_volume_size_invalid');
    }
    const image = await fetchUsableImage(sess, imageRef);
    let flavor;
    try {
      flavor = (await osFetch(sess, 'compute', `/flavors/${encodeURIComponent(flavorRef)}`))?.flavor;
    } catch (failure) {
      if (failure?.status === 404) throw new OSError(400, 'Flavor đã chọn không khả dụng.', 'flavor_unavailable');
      if (failure?.status === 401) throw new OSError(401, 'Phiên đăng nhập không còn hiệu lực.', 'authentication_required');
      if (failure?.status === 403) throw new OSError(403, 'Không có quyền xem Flavor.', 'permission_denied');
      throw new OSError(502, 'Không thể kiểm tra Flavor đã chọn.', 'provider_failure');
    }
    if (!flavor) throw new OSError(502, 'Nova không trả về thông tin Flavor.', 'provider_failure');
    const preflight = preflightImageFlavor(image, flavor, {
      bootFromVolume: Number(boot_volume_gb) > 0, bootVolumeGiB: boot_volume_gb,
    });
    if (preflight) {
      const error = new OSError(400, 'Image không đáp ứng yêu cầu của Flavor đã chọn.', preflight.code);
      error.context = preflight.context;
      throw error;
    }
    if (req.body?.networks !== undefined || req.body?.security_groups !== undefined) {
      throw new OSError(400, 'Dùng danh sách interfaces; Security Group mặc định do CMP xác định.', 'interface_contract_invalid');
    }
    const prepared = await prepareInterfaces(sess, interfaces);
    const server = {
      name,
      flavorRef,
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
    const n = Math.max(1, Math.min(Math.floor(Number(count)) || 1, 10));
    if (n > 1 && prepared.specs.some((spec) => spec.ip_address)) {
      throw new OSError(400, 'Không thể dùng cùng fixed IP khi tạo nhiều VM.', 'interface_batch_fixed_ip');
    }
    if (user_data && String(user_data).trim()) {
      if (String(user_data).length > 60000) throw new OSError(400, 'user-data quá dài (tối đa ~60KB)');
      server.user_data = Buffer.from(String(user_data)).toString('base64');
    }

    const created = [];
    let classificationWarning = false;
    for (let index = 0; index < n; index++) {
      try {
        // A Neutron Port belongs to one server only; a multi-create needs a fresh set per VM.
        const result = await createServerWithInterfaces(sess, {
          ...server, name: n > 1 ? `${name}-${index + 1}` : name,
        }, prepared);
        created.push(result.data);
        if (classification.labels.length || classification.tag_ids.length) {
          try {
            const { diff } = replaceAssignments(sess.project.id, result.data.server.id, classification);
            if (diff.labels.added.length) addInstanceAudit(res, { action: 'instance.labels.update', resourceId: result.data.server.id,
              resourceName: result.data.server.name, details: diff.labels, provider: 'cmp' });
            if (diff.tags.added.length) addInstanceAudit(res, { action: 'instance.tags.update', resourceId: result.data.server.id,
              resourceName: result.data.server.name, details: diff.tags, provider: 'cmp' });
          }
          catch {
            classificationWarning = true;
            console.error(`[classification] Assignment failed after VM create request_id=${req.id} instance=${result.data.server.id}`);
          }
        }
        addInstanceAudit(res, { action: 'instance.create', resourceId: result.data.server.id,
          resourceName: result.data.server.name || (n > 1 ? `${name}-${index + 1}` : name),
          result: 'accepted', status: 202,
          details: { image_id: imageRef, image_name: image.name || null,
            flavor_id: flavorRef, interface_count: result.ports.length } });
      } catch (error) {
        if (!created.length) throw error;
        console.error(`[compute] Partial VM batch project=${sess.project.id} servers=${created.map((item) => item?.server?.id).join(',')}`);
        throw new OSError(502, 'Một số VM đã được tạo; kiểm tra danh sách trước khi thử lại.', 'interface_batch_partial_failure');
      }
    }
    console.log(`[compute] CREATE server name=${name} x${n} by=${sess.user.name}`);
    res.status(202).json(n === 1 ? { ...publicServerPayload(created[0]), classification_warning: classificationWarning }
      : { server: publicServer(created[0]?.server), servers: created.map((item) => publicServer(item?.server)), classification_warning: classificationWarning });
  } catch (e) { next(e); }
});

router.get('/servers/:id', async (req, res, next) => {
  try {
    const server = await fetchOwned(req.session.os, 'compute', `/servers/${req.params.id}`, 'server');
    const instanceError = classifyInstanceError(server);
    if (instanceError) recordInstanceErrorOnce(req.session.os, server, instanceError, req.id);
    const classification = assignmentsForInstances(req.session.os.project.id, [server.id])[server.id];
    res.json({ server: { ...publicServer(server), classification,
      ...(instanceError ? { instance_error: { code: instanceError.code, category: instanceError.category } } : {}) } });
  } catch (e) { next(e); }
});

router.get('/servers/:id/error', async (req, res, next) => {
  try {
    const server = await fetchOwned(req.session.os, 'compute', `/servers/${encodeURIComponent(req.params.id)}`, 'server');
    const error = classifyInstanceError(server);
    if (error) recordInstanceErrorOnce(req.session.os, server, error, req.id);
    const imageId = error?.code === 'IMAGE_SIZE_EXCEEDS_VOLUME' ? faultImageId(server) || server.image?.id : null;
    const image = imageId ? await fetchUsableImage(req.session.os, imageId).catch(() => null) : null;
    const safeImageName = typeof image?.name === 'string' && image.name.length <= 255 ? image.name : null;
    res.setHeader('Cache-Control', 'no-store');
    res.json({ error: error && safeImageName ? { ...error, image_name: safeImageName } : error });
  } catch (failure) {
    // Provider error bodies can contain diagnostics too. The customer-facing
    // error endpoint never forwards them, including on failed Nova reads.
    if (failure?.code === 'resource_not_found' || failure?.status === 404) {
      next(new OSError(404, 'Không tìm thấy tài nguyên trong project hiện tại.', 'resource_not_found'));
    } else if (failure?.status === 401) {
      next(new OSError(401, 'Phiên đăng nhập không còn hiệu lực.', 'authentication_required'));
    } else if (failure?.status === 403) {
      next(new OSError(403, 'Không có quyền xem tài nguyên này.', 'permission_denied'));
    } else {
      next(new OSError(502, 'Không thể tải thông tin lỗi máy ảo.', 'provider_failure'));
    }
  }
});

router.get('/servers/:id/classifications', async (req, res, next) => {
  try {
    const server = await fetchOwned(req.session.os, 'compute', `/servers/${encodeURIComponent(req.params.id)}`, 'server');
    res.json({ classification: assignmentsForInstances(req.session.os.project.id, [server.id])[server.id] });
  } catch (error) { next(error); }
});

router.put('/servers/:id/classifications', async (req, res, next) => {
  try {
    if (!req.session.os.roles?.some((role) => ['member', 'admin'].includes(role))) {
      throw new OSError(403, 'Cần role member hoặc admin để gán Labels/Tags.', 'permission_denied');
    }
    const server = await fetchOwned(req.session.os, 'compute', `/servers/${encodeURIComponent(req.params.id)}`, 'server');
    const { classification, diff } = replaceAssignments(req.session.os.project.id, server.id, req.body);
    if (Object.values(diff.labels).some((items) => items.length)) {
      addInstanceAudit(res, { action: 'instance.labels.update', resourceId: server.id, resourceName: server.name,
        details: diff.labels, provider: 'cmp' });
    }
    if (diff.tags.added.length || diff.tags.removed.length) {
      addInstanceAudit(res, { action: 'instance.tags.update', resourceId: server.id, resourceName: server.name,
        details: diff.tags, provider: 'cmp' });
    }
    res.json({ classification });
  } catch (error) { next(error); }
});

router.get('/servers/:id/activity', async (req, res, next) => {
  try {
    await fetchOwned(req.session.os, 'compute', `/servers/${req.params.id}`, 'server');
    const limit = Number.isFinite(Number(req.query.limit))
      ? Math.max(1, Math.min(Math.floor(Number(req.query.limit)) || 50, 100)) : 50;
    const offset = Number.isFinite(Number(req.query.offset))
      ? Math.max(0, Math.min(Math.floor(Number(req.query.offset)), 5000)) : 0;
    const rows = listInstanceAudit({ projectId: req.session.os.project.id, instanceId: req.params.id,
      limit: limit + 1, offset });
    res.json({ entries: rows.slice(0, limit), next_offset: rows.length > limit ? offset + limit : null });
  } catch (error) { next(error); }
});

router.post('/servers/:id/change-password', async (req, res, next) => {
  try {
    const result = await changeInstancePassword(req.session.os, req.params.id, req.body?.password);
    setInstanceAudit(res, { action: 'instance.password.change', resourceId: req.params.id,
      resourceName: result.instanceName, result: 'accepted' });
    res.setHeader('Cache-Control', 'no-store');
    res.status(202).json({ success: true });
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

const RESIZE_ACTIONS = new Set(['resize', 'confirm-resize', 'revert-resize']);

export function resizeError(error) {
  const mapped = (() => {
    if (error?.status === 401) return new OSError(401, 'Phiên OpenStack đã hết hạn.', 'authentication_required');
    if (error?.status === 403) return new OSError(403, 'Nova từ chối quyền thao tác resize VM.', 'permission_denied');
    if (error?.status === 404) return new OSError(404, 'Không tìm thấy VM hoặc flavor trong project hiện tại.', 'resource_not_found');
    if (error?.status === 400) return new OSError(400, 'Nova từ chối flavor hoặc yêu cầu resize.', 'invalid_resize_request');
    if (error?.status === 409) return new OSError(409, 'Không thể resize VM ở trạng thái hiện tại.', 'invalid_instance_state');
    if (/(?:NoValidHost|insufficient|not enough|resources?)/i.test(error?.message || '')) {
      return new OSError(503, 'Compute host không đủ tài nguyên để resize VM.', 'insufficient_capacity');
    }
    if (error?.status === 503) return new OSError(503, 'Dịch vụ Nova hiện không khả dụng.', 'provider_unavailable');
    return new OSError(502, 'Nova không thể xử lý yêu cầu resize VM.', 'resize_provider_failure');
  })();
  mapped.expose = true; // Fixed messages only; never forward raw Nova text or request data.
  return mapped;
}

// Đổi tên máy ảo
router.put('/servers/:id', async (req, res, next) => {
  try {
    const previous = await fetchOwned(req.session.os, 'compute', `/servers/${req.params.id}`, 'server');
    const name = (req.body?.name || '').trim();
    if (!name) throw new OSError(400, 'Tên mới không được trống');
    setInstanceAudit(res, { action: 'instance.rename', resourceId: previous.id, resourceName: previous.name,
      details: { old_name: previous.name, new_name: name } });
    const data = await osFetch(req.session.os, 'compute', `/servers/${req.params.id}`, {
      method: 'PUT', body: { server: { name } },
    });
    console.log(`[compute] RENAME server=${req.params.id} -> ${name} by=${req.session.os.user.name}`);
    res.json(publicServerPayload(data));
  } catch (e) { next(e); }
});

// Cài lại hệ điều hành (rebuild) — giữ nguyên IP, ID máy, volume gắn kèm
router.post('/servers/:id/rebuild', async (req, res, next) => {
  try {
    const previous = await fetchOwned(req.session.os, 'compute', `/servers/${req.params.id}`, 'server');
    const { imageRef, name, user_data } = req.body || {};
    if (!imageRef) throw new OSError(400, 'Chọn image để cài lại');
    const image = await fetchUsableImage(req.session.os, imageRef);
    setInstanceAudit(res, { action: 'instance.rebuild', resourceId: previous.id,
      resourceName: previous.name, result: 'accepted',
      details: { image_id: imageRef, image_name: image.name || null } });
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
    await fetchOwned(req.session.os, 'compute', `/servers/${req.params.id}`, 'server');
    const d = await osFetch(req.session.os, 'network', `/v2.0/ports?project_id=${encodeURIComponent(req.session.os.project.id)}&device_id=${encodeURIComponent(req.params.id)}`);
    res.json({ interfaces: owned(d.ports, req.session.os) });
  } catch (e) { next(e); }
});

router.post('/servers/:id/interfaces', async (req, res, next) => {
  try {
    const sess = req.session.os;
    const server = await fetchOwned(sess, 'compute', `/servers/${req.params.id}`, 'server');
    setInstanceAudit(res, { action: 'instance.interface.attach', resourceId: server.id,
      resourceName: server.name, result: 'accepted' });
    const { data, port } = await attachInterface(sess, req.params.id, req.body);
    setInstanceAudit(res, { action: 'instance.interface.attach', resourceId: server.id,
      resourceName: server.name, result: 'accepted', details: {
        port_id: port.id, network_id: port.network_id,
        subnet_id: port.fixed_ips?.[0]?.subnet_id || null,
        ip_address: port.fixed_ips?.[0]?.ip_address || null, mac_address: port.mac_address || null,
      } });
    console.log(`[compute] ATTACH nic server=${req.params.id} port=${port.id} net=${port.network_id} by=${sess.user.name}`);
    res.json(data);
  } catch (e) { next(e); }
});

router.delete('/servers/:id/interfaces/:portId', async (req, res, next) => {
  try {
    const server = await fetchOwned(req.session.os, 'compute', `/servers/${req.params.id}`, 'server');
    const port = await fetchOwned(req.session.os, 'network', `/v2.0/ports/${req.params.portId}`, 'port');
    if (port.device_id !== req.params.id) throw new OSError(404, 'Không tìm thấy tài nguyên trong project hiện tại.', 'resource_not_found');
    setInstanceAudit(res, { action: 'instance.interface.detach', resourceId: server.id,
      resourceName: server.name, result: 'accepted', details: {
        port_id: port.id, network_id: port.network_id,
        subnet_id: port.fixed_ips?.[0]?.subnet_id || null,
        ip_address: port.fixed_ips?.[0]?.ip_address || null, mac_address: port.mac_address || null,
      } });
    await osFetch(req.session.os, 'compute', `/servers/${req.params.id}/os-interface/${req.params.portId}`, { method: 'DELETE' });
    console.log(`[compute] DETACH nic server=${req.params.id} port=${req.params.portId} by=${req.session.os.user.name}`);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Đổi security group của máy đang chạy
router.post('/servers/:id/security-groups', async (req, res, next) => {
  try {
    const { add = [], remove = [] } = req.body || {};
    const server = await fetchOwned(req.session.os, 'compute', `/servers/${req.params.id}`, 'server');
    const groups = owned((await osFetch(req.session.os, 'network', '/v2.0/security-groups')).security_groups, req.session.os);
    if ([...add, ...remove].some((name) => !groups.some((group) => group.name === name))) {
      throw new OSError(404, 'Không tìm thấy tài nguyên trong project hiện tại.', 'resource_not_found');
    }
    setInstanceAudit(res, { action: 'instance.security_groups.change', resourceId: server.id,
      resourceName: server.name, details: { added: add, removed: remove } });
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
    const resizeLifecycle = RESIZE_ACTIONS.has(action);
    let body;
    let server;
    if (action === 'snapshot') {
      if (!name) throw new OSError(400, 'Thiếu tên snapshot');
      body = { createImage: { name } };
    } else if (action === 'resize') {
      if (typeof flavorRef !== 'string' || !flavorRef.trim()) throw new OSError(400, 'Thiếu flavor mới để resize');
      body = { resize: { flavorRef } };
    } else {
      body = ACTIONS[action];
      if (!body) throw new OSError(400, `Hành động không hợp lệ: ${action}`);
    }

    if (resizeLifecycle) {
      if (!req.session.os.roles?.some((role) => role === 'member' || role === 'admin')) {
        throw new OSError(403, 'Cần role member hoặc admin để thao tác resize VM.', 'permission_denied');
      }
      try {
        server = (await osFetch(req.session.os, 'compute', `/servers/${encodeURIComponent(req.params.id)}`))?.server;
      } catch (error) { throw resizeError(error); }
      if (server?.id !== req.params.id) throw new OSError(404, 'Không tìm thấy VM trong project hiện tại.', 'server_not_found');
      assertOwned(server, req.session.os);
    } else {
      server = await fetchOwned(req.session.os, 'compute', `/servers/${req.params.id}`, 'server');
    }
    const oldFlavor = server.flavor?.original_name || server.flavor?.name || server.flavor?.id || null;
    const newFlavor = action === 'resize' && /^[A-Za-z0-9_.-]{1,128}$/.test(flavorRef)
      ? flavorRef : null;
    const auditEvent = { action: instanceActionCode(action), resourceId: server.id,
      resourceName: server.name, result: 'accepted',
      details: action === 'resize' ? { old_flavor: oldFlavor, new_flavor: newFlavor }
        : resizeLifecycle ? { old_flavor: oldFlavor }
          : action === 'snapshot' ? { snapshot_name: name } : {},
      legacy: resizeLifecycle ? { old_flavor: server.flavor?.id || null,
        ...(action === 'resize' ? { requested_flavor: newFlavor } : {}) } : {},
    };
    setInstanceAudit(res, auditEvent);
    if (action === 'resize' && flavorRef === server.flavor?.id) {
      throw new OSError(400, 'Chọn flavor khác cấu hình hiện tại.', 'same_flavor');
    }

    let data;
    try {
      data = await osFetch(req.session.os, 'compute', `/servers/${encodeURIComponent(req.params.id)}/action`, {
        method: 'POST', body, ...(resizeLifecycle ? { responseType: 'none' } : {}),
      });
    } catch (error) {
      if (resizeLifecycle) throw resizeError(error);
      throw error;
    }
    if (action === 'snapshot' && typeof data?.image_id === 'string') {
      auditEvent.details.image_id = data.image_id;
    }
    console.log(`[compute] ACTION ${action} server=${req.params.id} by=${req.session.os.user.name}`);
    if (resizeLifecycle) return res.status(202).json({ success: true, accepted: true });
    res.json(data || { ok: true });
  } catch (e) { next(e); }
});

router.delete('/servers/:id', async (req, res, next) => {
  try {
    let auditEvent;
    const result = await deleteInstanceWithPorts(req.session.os, req.params.id, { onValidated(server) {
      auditEvent = { action: 'instance.delete', resourceId: server.id, resourceName: server.name };
      setInstanceAudit(res, auditEvent);
    } });
    let classificationWarning = false;
    if (result.instance_deleted) {
      try { removeInstanceAssignments(req.session.os.project.id, result.server.id); }
      catch { classificationWarning = true; console.error(`[classification] VM delete cleanup failed request_id=${req.id} instance=${req.params.id}`); }
    }
    auditEvent.result = result.instance_deleted ? 'success' : 'accepted';
    auditEvent.details = { instance_id: result.server.id,
      ports_captured: result.cleanup.ports_captured,
      ports_deleted: result.cleanup.ports_deleted,
      ports_already_gone: result.cleanup.ports_already_gone,
      ports_pending: result.cleanup.ports_pending || 0,
      failed_port_ids: result.cleanup.failed_port_ids,
      volume_policy: 'nova_delete_on_termination' };
    for (const warning of result.warnings) {
      console.warn(`[compute] VM delete cleanup warning request_id=${req.id} instance=${result.server.id} port=${warning.port_id || '-'} reason=${warning.reason || warning.code}`);
    }
    console.log(`[compute] DELETE server=${req.params.id} by=${req.session.os.user.name}`);
    res.status(result.instance_deleted ? 200 : 202).json({ ok: true, success: true, instance_deleted: result.instance_deleted,
      cleanup: result.cleanup, warnings: result.warnings, classification_warning: classificationWarning });
  } catch (e) { next(e); }
});

router.post('/servers/:id/console', async (req, res, next) => {
  try {
    const server = await fetchOwned(req.session.os, 'compute', `/servers/${req.params.id}`, 'server');
    setInstanceAudit(res, { action: 'instance.console.open', resourceId: server.id, resourceName: server.name });
    const data = await osFetch(req.session.os, 'compute', `/servers/${req.params.id}/remote-consoles`, {
      method: 'POST',
      body: { remote_console: { protocol: 'vnc', type: 'novnc' } },
    });
    traceNovaConsole(data, req.id);
    res.setHeader('Cache-Control', 'no-store');
    res.json(data);
  } catch (e) { next(e); }
});

// Log console của máy ảo (boot log / cloud-init) — hữu ích khi VM không SSH được
router.get('/servers/:id/console-log', async (req, res, next) => {
  try {
    await fetchOwned(req.session.os, 'compute', `/servers/${req.params.id}`, 'server');
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
    await fetchOwned(req.session.os, 'compute', `/servers/${req.params.id}`, 'server');
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
