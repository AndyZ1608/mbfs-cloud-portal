// backup.js — API quản lý policy backup tự động + nhật ký hoạt động
import { Router } from 'express';
import { OSError } from '../openstack.js';
import { svcConfigured } from '../svcauth.js';
import { persistent } from '../store.js';
import { listPolicies, addPolicy, patchPolicy, removePolicy, runPolicy, SCHED_TZ } from '../scheduler.js';
import { listAudit } from '../audit.js';

const router = Router();
const uid = () => crypto.randomUUID();

router.get('/backup/status', (req, res) => {
  res.json({ configured: svcConfigured(), persistent: persistent(), tz: SCHED_TZ });
});

router.get('/backup/policies', (req, res) => {
  res.json({ policies: listPolicies(req.session.os.project.id) });
});

router.post('/backup/policies', (req, res, next) => {
  try {
    const sess = req.session.os;
    const { type, target_id, target_name, schedule, retention } = req.body || {};
    if (!['volume', 'server'].includes(type)) throw new OSError(400, 'Loại backup không hợp lệ');
    if (!target_id || !target_name) throw new OSError(400, 'Thiếu tài nguyên cần backup');
    const s = schedule || {};
    if (!['daily', 'weekly'].includes(s.freq)) throw new OSError(400, 'Tần suất phải là daily/weekly');
    const hour = Number(s.hour), minute = Number(s.minute);
    if (!(hour >= 0 && hour <= 23) || !(minute >= 0 && minute <= 59)) throw new OSError(400, 'Giờ chạy không hợp lệ');
    if (s.freq === 'weekly' && !(Number(s.weekday) >= 0 && Number(s.weekday) <= 6)) throw new OSError(400, 'Thiếu thứ trong tuần');
    if (listPolicies(sess.project.id).length >= 50) throw new OSError(400, 'Tối đa 50 policy mỗi project');

    const pol = addPolicy({
      id: uid(),
      project_id: sess.project.id,
      project_name: sess.project.name,
      type, target_id, target_name,
      schedule: { freq: s.freq, hour, minute, weekday: s.freq === 'weekly' ? Number(s.weekday) : undefined },
      retention: Math.max(1, Math.min(90, Number(retention) || 7)),
      enabled: true,
      created_by: sess.user.name,
      created_at: new Date().toISOString(),
      last_run: null,
    });
    console.log(`[backup] NEW policy ${pol.type}/${pol.target_name} by=${sess.user.name}`);
    res.json({ policy: pol });
  } catch (e) { next(e); }
});

router.patch('/backup/policies/:id', (req, res, next) => {
  try {
    const p = patchPolicy(req.params.id, req.session.os.project.id, req.body || {});
    if (!p) throw new OSError(404, 'Không tìm thấy policy');
    res.json({ policy: p });
  } catch (e) { next(e); }
});

router.delete('/backup/policies/:id', (req, res, next) => {
  try {
    if (!removePolicy(req.params.id, req.session.os.project.id)) throw new OSError(404, 'Không tìm thấy policy');
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/backup/policies/:id/run', async (req, res, next) => {
  try {
    const pol = listPolicies(req.session.os.project.id).find((x) => x.id === req.params.id);
    if (!pol) throw new OSError(404, 'Không tìm thấy policy');
    const r = await runPolicy(pol);
    res.json({ ok: true, ...r, last_run: pol.last_run });
  } catch (e) { next(e); }
});

// ---------- Nhật ký hoạt động ----------
router.get('/audit', (req, res) => {
  const sess = req.session.os;
  const limit = Math.min(Number(req.query.limit) || 300, 1000);
  res.json({ entries: listAudit({ projectId: sess.project.id, user: sess.user.name, limit }) });
});

export default router;
