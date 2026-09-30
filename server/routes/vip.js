import { Router } from 'express';
import { subnetPorts, subnetVips, createVip, deleteVip, vipAssignments, setVipAssignments,
  portVips, setPortVips, ownedSubnet, isVipPort, serverVips, changeVipVmAssignment } from '../vip.js';

const router = Router();
const eventFor = ({ action, vip, target }) => ({ action, resourceId: vip.id, resourceName: vip.name,
  instanceId: target?.device_id || null,
  details: { vip_port_id: vip.id, vip_name: vip.name, vip_ip: vip.fixed_ips?.[0]?.ip_address,
    network_id: vip.network_id, subnet_id: vip.fixed_ips?.[0]?.subnet_id,
    ...(target ? { target_port_id: target.id, instance_id: target.device_id,
      fixed_ip: target.fixed_ips?.[0]?.ip_address } : {}) } });

router.get('/subnets/:id', async (req, res, next) => {
  try { res.json(await ownedSubnet(req.session.os, req.params.id)); } catch (error) { next(error); }
});

router.get('/subnets/:id/ports', async (req, res, next) => {
  try {
    const { ports } = await subnetPorts(req.session.os, req.params.id);
    res.json({ ports: ports.map((port) => ({ ...port, cmp_vip: isVipPort(port) })) });
  } catch (error) { next(error); }
});

router.get('/subnets/:id/vips', async (req, res, next) => {
  try { res.json(await subnetVips(req.session.os, req.params.id)); } catch (error) { next(error); }
});

router.post('/subnets/:id/vips', async (req, res, next) => {
  try {
    const vip = await createVip(req.session.os, req.params.id, req.body);
    res.locals.networkAudits = [eventFor({ action: 'vip.create', vip })];
    res.status(201).json({ vip });
  } catch (error) { next(error); }
});

router.delete('/vips/:id', async (req, res, next) => {
  try {
    const vip = await deleteVip(req.session.os, req.params.id);
    res.locals.networkAudits = [eventFor({ action: 'vip.delete', vip })];
    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.get('/vips/:id/assignments', async (req, res, next) => {
  try { res.json(await vipAssignments(req.session.os, req.params.id)); } catch (error) { next(error); }
});

for (const [action, assign] of [['attach', true], ['detach', false]]) {
  router.post(`/vips/:id/${action}`, async (req, res, next) => {
    try {
      const result = await changeVipVmAssignment(req.session.os, req.params.id,
        req.body?.server_id, req.body?.port_id, assign);
      res.locals.networkAudits = result.events.map(eventFor);
      res.json({ ok: true, changed: result.events.length });
    } catch (error) { next(error); }
  });
}

router.put('/vips/:id/assignments', async (req, res, next) => {
  try {
    const result = await setVipAssignments(req.session.os, req.params.id, req.body?.port_ids);
    res.locals.networkAudits = result.events.map(eventFor);
    res.json({ ok: true, changed: result.events.length });
  } catch (error) {
    if (error.events?.length) res.locals.networkAudits = error.events.map((event) => ({ ...eventFor(event), result: 'success' }));
    next(error);
  }
});

router.get('/ports/:id/vips', async (req, res, next) => {
  try { res.json(await portVips(req.session.os, req.params.id)); } catch (error) { next(error); }
});

router.get('/servers/:id/vips', async (req, res, next) => {
  try { res.json(await serverVips(req.session.os, req.params.id)); } catch (error) { next(error); }
});

router.put('/ports/:id/vips', async (req, res, next) => {
  try {
    const result = await setPortVips(req.session.os, req.params.id, req.body?.vip_port_ids);
    res.locals.networkAudits = result.events.map(eventFor);
    res.json({ ok: true, changed: result.events.length });
  } catch (error) { next(error); }
});

export default router;
