// monitor routes — trạng thái, số liệu mới nhất theo project, chuỗi theo VM
import { Router } from 'express';
import { OSError } from '../openstack.js';
import { monitorStatus, latestFor, seriesFor } from '../monitor.js';

const router = Router();

router.get('/monitor/status', (req, res) => res.json(monitorStatus()));

router.get('/monitor/latest', (req, res) => {
  res.json({ latest: latestFor(req.session.os.project.id) });
});

router.get('/monitor/servers/:id', (req, res, next) => {
  try {
    const hours = Math.min(Number(req.query.hours) || 24, 168);
    const d = seriesFor(req.session.os.project.id, req.params.id, hours);
    if (!d) throw new OSError(404, 'Chưa có dữ liệu giám sát cho máy này (chờ 2 chu kỳ lấy mẫu, hoặc VM thuộc project khác)');
    res.json(d);
  } catch (e) { next(e); }
});

export default router;
