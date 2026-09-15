import { Router } from 'express';
import { listNotices, unreadCount, markRead } from '../notify.js';

const router = Router();

router.get('/notifications', (req, res) => {
  const s = req.session.os;
  res.json({
    notifications: listNotices(s.project.id, Math.min(Number(req.query.limit) || 50, 200)),
    unread: unreadCount(s.user.name, s.project.id),
  });
});

router.post('/notifications/read', (req, res) => {
  const s = req.session.os;
  markRead(s.user.name, s.project.id);
  res.json({ ok: true });
});

export default router;

// Gửi thử báo cáo chi phí ngay (để kiểm tra cấu hình Telegram)
import { sendMonthly } from '../report.js';
router.post('/notifications/test-report', async (req, res, next) => {
  try {
    if (!(req.session.os.roles || []).includes('admin')) throw Object.assign(new Error('Cần role admin'), { status: 403 });
    await sendMonthly();
    res.json({ ok: true });
  } catch (e) { next(e); }
});
