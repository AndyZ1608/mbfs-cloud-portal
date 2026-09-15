import { Router } from 'express';
import { OSError } from '../openstack.js';
import { listRules, addRule, patchRule, removeRule, powerConfigured } from '../power.js';
import { SCHED_TZ } from '../scheduler.js';

const router = Router();

router.get('/power/rules', (req, res) => {
  res.json({ rules: listRules(req.session.os.project.id), configured: powerConfigured(), tz: SCHED_TZ });
});

router.post('/power/rules', (req, res, next) => {
  try {
    const sess = req.session.os;
    const { server_id, server_name, action, days, hour, minute } = req.body || {};
    if (!server_id || !server_name) throw new OSError(400, 'Thiếu máy ảo');
    if (!['stop', 'start'].includes(action)) throw new OSError(400, 'Hành động phải là stop/start');
    const d = (days || []).map(Number).filter((x) => x >= 0 && x <= 6);
    if (!d.length) throw new OSError(400, 'Chọn ít nhất một ngày trong tuần');
    const h = Number(hour), m = Number(minute);
    if (!(h >= 0 && h <= 23) || !(m >= 0 && m <= 59)) throw new OSError(400, 'Giờ không hợp lệ');
    if (listRules(sess.project.id).length >= 100) throw new OSError(400, 'Tối đa 100 quy tắc mỗi project');
    const rule = addRule({
      id: crypto.randomUUID(),
      project_id: sess.project.id, project_name: sess.project.name,
      server_id, server_name, action,
      schedule: { days: [...new Set(d)].sort(), hour: h, minute: m },
      enabled: true, created_by: sess.user.name, created_at: new Date().toISOString(), last_run: null,
    });
    console.log(`[power] NEW rule ${action} ${server_name} by=${sess.user.name}`);
    res.json({ rule });
  } catch (e) { next(e); }
});

router.patch('/power/rules/:id', (req, res, next) => {
  try {
    if (typeof req.body?.enabled !== 'boolean') throw new OSError(400, 'enabled phải là boolean');
    const r = patchRule(req.params.id, req.session.os.project.id, { enabled: req.body.enabled });
    if (!r) throw new OSError(404, 'Không tìm thấy quy tắc');
    res.json({ rule: r });
  } catch (e) { next(e); }
});

router.delete('/power/rules/:id', (req, res, next) => {
  try {
    if (!removeRule(req.params.id, req.session.os.project.id)) throw new OSError(404, 'Không tìm thấy quy tắc');
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
