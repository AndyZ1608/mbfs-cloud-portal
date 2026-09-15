// billing.js — Báo cáo chi phí & sử dụng kiểu AWS Cost Explorer / Bills
// Nguồn dữ liệu:
//   - Compute : Nova os-simple-tenant-usage (gồm cả máy đã xoá trong kỳ)
//   - Storage : Cinder volumes/snapshots hiện có (tính từ created_at; volume đã xoá không truy được)
//   - Network : Neutron floating IPs hiện có (tính từ created_at nếu Neutron trả về)
import { Router } from 'express';
import { osFetch, OSError } from '../openstack.js';

const router = Router();

const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
const PRICES = {
  vcpu_hour: num(process.env.PRICE_VCPU_HOUR),
  ram_gb_hour: num(process.env.PRICE_RAM_GB_HOUR),
  disk_gb_hour: num(process.env.PRICE_DISK_GB_HOUR),
  volume_gb_hour: num(process.env.PRICE_VOLUME_GB_HOUR),
  snapshot_gb_hour: num(process.env.PRICE_SNAPSHOT_GB_HOUR),
  fip_hour: num(process.env.PRICE_FIP_HOUR),
};
const PRICING = {
  ...PRICES,
  currency: process.env.CURRENCY || 'VND',
  enabled: Object.values(PRICES).some((v) => v > 0),
};

// Nova/Cinder trả thời gian UTC nhưng KHÔNG có hậu tố Z → tự thêm để parse đúng
function parseUtc(s) {
  if (!s) return null;
  const t = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s + 'Z');
  return Number.isFinite(t) ? t : null;
}
const HOUR = 3600000;
const r2 = (x) => Math.round(x * 100) / 100;
const overlapH = (aS, aE, bS, bE) => Math.max(0, (Math.min(aE, bE) - Math.max(aS, bS)) / HOUR);

router.get('/billing', async (req, res, next) => {
  try {
    const sess = req.session.os;
    const { start, end } = req.query;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(end || '')) {
      throw new OSError(400, 'start/end phải theo định dạng YYYY-MM-DD');
    }
    const now = Date.now();
    const pStart = Date.parse(start + 'T00:00:00Z');
    const pEndReq = Date.parse(end + 'T23:59:59Z') + 1000;
    if (!(pStart < pEndReq)) throw new OSError(400, 'Kỳ không hợp lệ (start phải trước end)');
    if ((pEndReq - pStart) / 86400000 > 92) throw new OSError(400, 'Kỳ tối đa 92 ngày');
    const pEnd = Math.min(pEndReq, now); // không tính giờ tương lai
    if (pEnd <= pStart) throw new OSError(400, 'Kỳ nằm hoàn toàn trong tương lai');

    // ---- Gọi song song 4 nguồn ----
    const novaEnd = new Date(pEnd).toISOString().slice(0, 19);
    const novaStart = new Date(pStart).toISOString().slice(0, 19);
    const [novaR, volR, snapR, fipR] = await Promise.allSettled([
      osFetch(sess, 'compute', `/os-simple-tenant-usage/${sess.project.id}?start=${novaStart}&end=${novaEnd}&detailed=1`),
      osFetch(sess, 'volume', '/volumes/detail?limit=1000'),
      osFetch(sess, 'volume', '/snapshots/detail?limit=1000'),
      osFetch(sess, 'network', '/v2.0/floatingips'),
    ]);
    const novaUsages = novaR.status === 'fulfilled' ? (novaR.value?.tenant_usage?.server_usages || []) : [];
    const volumes = volR.status === 'fulfilled' ? (volR.value?.volumes || []) : [];
    const snapshots = snapR.status === 'fulfilled' ? (snapR.value?.snapshots || []) : [];
    const fips = fipR.status === 'fulfilled' ? (fipR.value?.floatingips || []) : [];

    // ---- Chuẩn hoá tài nguyên thành các "dòng tính phí" {from, to, rate, ...} ----
    const svRows = novaUsages.map((s) => {
      const from = parseUtc(s.started_at) ?? pStart;
      const to = parseUtc(s.ended_at) ?? pEnd;
      const ramGb = (s.memory_mb || 0) / 1024;
      const rate = (s.vcpus || 0) * PRICES.vcpu_hour + ramGb * PRICES.ram_gb_hour + (s.local_gb || 0) * PRICES.disk_gb_hour;
      const hours = r2(overlapH(from, to, pStart, pEnd));
      return { kind: 'server', name: s.name, state: s.state, vcpus: s.vcpus || 0, memory_mb: s.memory_mb || 0, local_gb: s.local_gb || 0, ended: !!s.ended_at, from, to, rate, hours, amount: r2(hours * rate) };
    });
    const volRows = volumes.map((v) => {
      const from = parseUtc(v.created_at) ?? pStart;
      const hours = r2(overlapH(from, pEnd, pStart, pEnd));
      const rate = (v.size || 0) * PRICES.volume_gb_hour;
      return { kind: 'volume', name: v.name || v.id.slice(0, 8), size: v.size || 0, status: v.status, from, to: pEnd, rate, hours, gb_hours: r2((v.size || 0) * hours), amount: r2(hours * rate) };
    });
    const snapRows = snapshots.map((v) => {
      const from = parseUtc(v.created_at) ?? pStart;
      const hours = r2(overlapH(from, pEnd, pStart, pEnd));
      const rate = (v.size || 0) * PRICES.snapshot_gb_hour;
      return { kind: 'snapshot', name: v.name || v.id.slice(0, 8), size: v.size || 0, from, to: pEnd, rate, hours, gb_hours: r2((v.size || 0) * hours), amount: r2(hours * rate) };
    });
    const fipRows = fips.map((f) => {
      const from = parseUtc(f.created_at) ?? pStart;
      const hours = r2(overlapH(from, pEnd, pStart, pEnd));
      return { kind: 'fip', name: f.floating_ip_address, attached: !!f.port_id, from, to: pEnd, rate: PRICES.fip_hour, hours, amount: r2(hours * PRICES.fip_hour) };
    });

    // ---- Chi phí theo ngày (stacked: compute / storage / network) ----
    const daily = [];
    for (let d = pStart; d < pEndReq && d < now + 86400000; d += 86400000) {
      const dEnd = Math.min(d + 86400000, pEnd);
      if (dEnd <= d) break;
      const sum = (rows) => rows.reduce((a, x) => a + overlapH(x.from, x.to, d, dEnd) * x.rate, 0);
      daily.push({
        date: new Date(d).toISOString().slice(0, 10),
        compute: r2(sum(svRows)),
        storage: r2(sum(volRows) + sum(snapRows)),
        network: r2(sum(fipRows)),
      });
    }
    daily.forEach((x) => { x.total = r2(x.compute + x.storage + x.network); });

    // ---- Line items theo dịch vụ (kiểu trang Bills của AWS) ----
    const qty = (rows, f) => r2(rows.reduce((a, x) => a + f(x), 0));
    const li = (name, unit, quantity, unit_price) => ({ name, unit, quantity, unit_price, amount: r2(quantity * unit_price) });
    const services = [
      { key: 'compute', label: 'Điện toán (Compute)', items: [
        li('vCPU', 'vCPU-giờ', qty(svRows, (s) => s.vcpus * s.hours), PRICES.vcpu_hour),
        li('RAM', 'GB-giờ', qty(svRows, (s) => (s.memory_mb / 1024) * s.hours), PRICES.ram_gb_hour),
        li('Đĩa local (flavor)', 'GB-giờ', qty(svRows, (s) => s.local_gb * s.hours), PRICES.disk_gb_hour),
      ] },
      { key: 'storage', label: 'Lưu trữ khối (Block Storage)', items: [
        li('Volume', 'GB-giờ', qty(volRows, (v) => v.gb_hours), PRICES.volume_gb_hour),
        li('Snapshot', 'GB-giờ', qty(snapRows, (v) => v.gb_hours), PRICES.snapshot_gb_hour),
      ] },
      { key: 'network', label: 'Mạng (Network)', items: [
        li('Floating IP', 'IP-giờ', qty(fipRows, (f) => f.hours), PRICES.fip_hour),
      ] },
    ];
    services.forEach((s) => { s.total = r2(s.items.reduce((a, i) => a + i.amount, 0)); });
    const total = r2(services.reduce((a, s) => a + s.total, 0));

    // ---- Dự báo hết kỳ (nếu kỳ còn đang chạy) ----
    let forecast = null;
    if (PRICING.enabled && now >= pStart && now < pEndReq) {
      const frac = (pEnd - pStart) / (pEndReq - pStart);
      if (frac > 0.02) forecast = { total: r2(total / frac), elapsed_pct: Math.round(frac * 100) };
    }

    res.json({
      period: { start, end, capped_to_now: pEnd < pEndReq },
      pricing: PRICING,
      summary: {
        total,
        by_service: Object.fromEntries(services.map((s) => [s.key, s.total])),
        forecast,
        usage: {
          server_hours: qty(svRows, (s) => s.hours),
          vcpu_hours: qty(svRows, (s) => s.vcpus * s.hours),
          ram_gb_hours: qty(svRows, (s) => (s.memory_mb / 1024) * s.hours),
        },
      },
      daily,
      services,
      resources: {
        servers: svRows.map(({ from, to, rate, kind, ...x }) => x).sort((a, b) => b.amount - a.amount || b.hours - a.hours),
        volumes: volRows.map(({ from, to, rate, kind, ...x }) => x).sort((a, b) => b.amount - a.amount),
        snapshots: snapRows.map(({ from, to, rate, kind, ...x }) => x).sort((a, b) => b.amount - a.amount),
        fips: fipRows.map(({ from, to, rate, kind, ...x }) => x).sort((a, b) => b.amount - a.amount),
      },
      notes: {
        deleted_storage_not_counted: 'Volume/snapshot/FIP đã xoá trước thời điểm xem không truy vấn được (không như compute).',
      },
    });
  } catch (e) { next(e); }
});

export default router;
