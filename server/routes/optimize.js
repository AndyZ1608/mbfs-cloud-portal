// optimize.js — Khuyến nghị tối ưu tài nguyên từ dữ liệu OpenStack.
// Billing/cost data belongs exclusively to the external Billing service.
import { Router } from 'express';
import { osFetch } from '../openstack.js';
import { cpuStats, monitorStatus } from '../monitor.js';

const router = Router();
const days = (iso) => {
  const t = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso || '') ? iso : iso + 'Z');
  return Number.isFinite(t) ? Math.floor((Date.now() - t) / 86400000) : 0;
};

router.get('/optimize', async (req, res, next) => {
  try {
    const sess = req.session.os;
    const minIdleDays = Math.max(1, Number(req.query.days) || 7);
    const [srvR, volR, snapR, fipR] = await Promise.allSettled([
      osFetch(sess, 'compute', '/servers/detail?limit=1000'),
      osFetch(sess, 'volume', '/volumes/detail?limit=1000'),
      osFetch(sess, 'volume', '/snapshots/detail?limit=1000'),
      osFetch(sess, 'network', '/v2.0/floatingips'),
    ]);
    const servers = srvR.status === 'fulfilled' ? srvR.value.servers || [] : [];
    const volumes = volR.status === 'fulfilled' ? volR.value.volumes || [] : [];
    const snapshots = snapR.status === 'fulfilled' ? snapR.value.snapshots || [] : [];
    const fips = fipR.status === 'fulfilled' ? fipR.value.floatingips || [] : [];

    const findings = [];
    const push = (f) => findings.push(f);

    // 1) Máy ảo tắt lâu ngày — vẫn chiếm quota, vẫn tính phí đĩa/flavor
    for (const s of servers.filter((x) => x.status === 'SHUTOFF')) {
      const d = days(s.updated || s.created);
      if (d < minIdleDays) continue;
      const fl = s.flavor || {};
      push({
        type: 'vm_shutoff', severity: d >= 30 ? 'high' : 'medium',
        name: s.name, id: s.id, detail: `Đã tắt ${d} ngày · ${fl.vcpus || '?'} vCPU / ${Math.round((fl.ram || 0) / 1024)} GB`,
        advice: 'Xoá nếu không còn dùng, hoặc snapshot lại rồi xoá để giữ dữ liệu.',
      });
    }

    // 2) Máy ảo lỗi — chiếm quota mà không dùng được
    for (const s of servers.filter((x) => x.status === 'ERROR')) {
      push({
        type: 'vm_error', severity: 'high', name: s.name, id: s.id,
        detail: `Trạng thái ERROR ${days(s.created)} ngày — vẫn chiếm quota vCPU/RAM`,
        advice: 'Xoá máy rồi tạo lại; kiểm tra nguyên nhân ở phần Lỗi trong chi tiết máy.',
      });
    }

    // 2b) Máy ảo đang chạy nhưng CPU rất thấp (cần dữ liệu giám sát)
    const stats = cpuStats(sess.project.id, 24 * minIdleDays);
    const IDLE_PCT = Number(process.env.OPTIMIZE_IDLE_CPU_PCT) || 5;
    // Cần đủ dữ liệu mới dám kết luận; chỉnh được qua OPTIMIZE_MIN_SPAN_H (giờ)
    const MIN_SPAN = process.env.OPTIMIZE_MIN_SPAN_H !== undefined
      ? Number(process.env.OPTIMIZE_MIN_SPAN_H)
      : Math.min(24 * minIdleDays * 0.5, 24);
    let monitored = 0;
    for (const s of servers.filter((x) => x.status === 'ACTIVE')) {
      const st = stats[s.id];
      if (!st) continue;
      monitored++;
      if (st.span_h < MIN_SPAN || st.avg >= IDLE_PCT || st.max >= 50) continue;
      const fl = s.flavor || {};
      push({
        type: 'vm_idle', severity: (fl.vcpus || 0) >= 4 ? 'high' : 'medium',
        name: s.name, id: s.id,
        detail: `CPU trung bình ${st.avg}% (đỉnh ${st.max}%) trong ${st.span_h}h · ${fl.vcpus} vCPU / ${Math.round((fl.ram || 0) / 1024)} GB`,
        advice: 'Hạ flavor xuống mức nhỏ hơn (resize) sau khi xác nhận nhu cầu CPU/RAM.',
      });
    }

    // 3) Volume rảnh (không gắn máy nào)
    for (const v of volumes.filter((x) => x.status === 'available')) {
      const d = days(v.created_at);
      if (d < minIdleDays) continue;
      push({
        type: 'volume_orphan', severity: v.size >= 100 ? 'high' : 'medium',
        name: v.name || v.id.slice(0, 8), id: v.id,
        detail: `${v.size} GB không gắn vào máy nào, đã ${d} ngày`,
        advice: 'Gắn vào máy đang dùng, hoặc snapshot rồi xoá volume.',
      });
    }

    // 4) Floating IP cấp nhưng không gắn
    for (const f of fips.filter((x) => !x.port_id)) {
      push({
        type: 'fip_idle', severity: 'medium', name: f.floating_ip_address, id: f.id,
        detail: 'Đã cấp nhưng chưa gắn vào máy ảo/load balancer nào',
        advice: 'Trả IP về pool, khi cần cấp lại rất nhanh.',
      });
    }

    // 5) Snapshot quá cũ
    for (const s of snapshots) {
      const d = days(s.created_at);
      if (d < 90) continue;
      push({
        type: 'snapshot_old', severity: 'low', name: s.name || s.id.slice(0, 8), id: s.id,
        detail: `${s.size} GB, tạo cách đây ${d} ngày`,
        advice: 'Xoá nếu đã có bản backup mới hơn (policy backup tự động đã giữ N bản gần nhất).',
      });
    }

    const rank = { high: 0, medium: 1, low: 2 };
    findings.sort((a, b) => rank[a.severity] - rank[b.severity]);

    res.json({
      monitor: { ...monitorStatus(), servers_with_data: monitored, idle_threshold_pct: IDLE_PCT },
      counts: {
        vm_idle: findings.filter((f) => f.type === 'vm_idle').length,
        vm_shutoff: findings.filter((f) => f.type === 'vm_shutoff').length,
        vm_error: findings.filter((f) => f.type === 'vm_error').length,
        volume_orphan: findings.filter((f) => f.type === 'volume_orphan').length,
        fip_idle: findings.filter((f) => f.type === 'fip_idle').length,
        snapshot_old: findings.filter((f) => f.type === 'snapshot_old').length,
      },
      findings,
      note: monitored ? `Đã phân tích CPU của ${monitored} máy.` : 'Chưa có dữ liệu giám sát CPU — cần OS_TASK_* và quyền đọc Nova diagnostics.',
    });
  } catch (e) { next(e); }
});

export default router;
