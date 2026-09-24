// monitor routes — trạng thái, số liệu mới nhất theo project, chuỗi theo VM
import { Router } from 'express';
import { OSError } from '../openstack.js';
import { monitorStatus, latestFor, seriesFor } from '../monitor.js';
import { fetchOwned, owned } from '../projectScope.js';
import { osFetch } from '../openstack.js';

const router = Router();

router.get('/monitor/status', (req, res) => res.json(monitorStatus()));

router.get('/monitor/latest', async (req, res, next) => {
  try {
    const sess = req.session.os;
    const servers = owned((await osFetch(sess, 'compute', '/servers/detail')).servers, sess);
    const ids = new Set(servers.map((server) => server.id));
    res.json({ latest: Object.fromEntries(Object.entries(latestFor(sess.project.id)).filter(([id]) => ids.has(id))) });
  } catch (error) { next(error); }
});

router.get('/monitor/servers/:id', async (req, res, next) => {
  try {
    await fetchOwned(req.session.os, 'compute', `/servers/${req.params.id}`, 'server');
    const hours = Math.min(Number(req.query.hours) || 24, 168);
    const d = seriesFor(req.session.os.project.id, req.params.id, hours);
    if (!d) throw new OSError(404, 'Chưa có dữ liệu giám sát cho máy này (chờ 2 chu kỳ lấy mẫu, hoặc VM thuộc project khác)');
    res.json(d);
  } catch (e) { next(e); }
});

export default router;
