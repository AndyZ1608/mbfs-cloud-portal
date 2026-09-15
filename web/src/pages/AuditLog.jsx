import React, { useEffect, useMemo, useState } from 'react';
import { api, fmtDate } from '../api.js';
import { StatusBadge, toast, Empty, PageHead } from '../components/ui.jsx';

// Ánh xạ method+path → mô tả tiếng Việt (thứ tự quan trọng: cụ thể trước)
const RULES = [
  [/^POST \/auth\/login$/, 'Đăng nhập'],
  [/^POST \/auth\/logout$/, 'Đăng xuất'],
  [/^POST \/auth\/switch-project$/, 'Đổi project'],
  [/^JOB \/backup\/run\//, 'Backup tự động (job)'],
  [/^POST \/backup\/policies\/[^/]+\/run$/, 'Chạy backup thủ công'],
  [/^POST \/backup\/policies$/, 'Tạo policy backup'],
  [/^PATCH \/backup\/policies\//, 'Sửa policy backup'],
  [/^DELETE \/backup\/policies\//, 'Xoá policy backup'],
  [/^POST \/servers\/[^/]+\/action$/, 'Thao tác máy ảo (start/stop/resize/snapshot…)'],
  [/^POST \/servers\/[^/]+\/console$/, 'Mở console'],
  [/^PUT \/servers\//, 'Đổi tên máy ảo'],
  [/^POST \/servers$/, 'Tạo máy ảo'],
  [/^DELETE \/servers\//, 'Xoá máy ảo'],
  [/^POST \/volumes\/[^/]+\/attach$/, 'Gắn volume'],
  [/^POST \/volumes\/[^/]+\/detach$/, 'Tháo volume'],
  [/^POST \/volumes\/[^/]+\/extend$/, 'Mở rộng volume'],
  [/^POST \/volumes$/, 'Tạo volume'],
  [/^DELETE \/volumes\//, 'Xoá volume'],
  [/^POST \/snapshots$/, 'Tạo snapshot'],
  [/^DELETE \/snapshots\//, 'Xoá snapshot'],
  [/^POST \/images\/[^/]+\/file$/, 'Upload dữ liệu image'],
  [/^PUT \/images\/[^/]+\/file$/, 'Upload dữ liệu image'],
  [/^POST \/images$/, 'Tạo image'],
  [/^DELETE \/images\//, 'Xoá image'],
  [/^POST \/networks$/, 'Tạo network'],
  [/^DELETE \/networks\//, 'Xoá network'],
  [/^POST \/routers\/[^/]+\/interfaces$/, 'Gắn interface router'],
  [/^DELETE \/routers\/[^/]+\/interfaces\//, 'Gỡ interface router'],
  [/^POST \/routers$/, 'Tạo router'],
  [/^DELETE \/routers\//, 'Xoá router'],
  [/^POST \/floatingips\/[^/]+\/associate$/, 'Gắn Floating IP'],
  [/^POST \/floatingips\/[^/]+\/disassociate$/, 'Gỡ Floating IP'],
  [/^POST \/floatingips$/, 'Cấp Floating IP'],
  [/^DELETE \/floatingips\//, 'Trả Floating IP'],
  [/^POST \/security-group-rules$/, 'Thêm rule security group'],
  [/^DELETE \/security-group-rules\//, 'Xoá rule security group'],
  [/^POST \/security-groups$/, 'Tạo security group'],
  [/^DELETE \/security-groups\//, 'Xoá security group'],
  [/^POST \/keypairs$/, 'Thêm SSH key'],
  [/^DELETE \/keypairs\//, 'Xoá SSH key'],
  [/^POST \/lb\/pools\/[^/]+\/members$/, 'Thêm backend LB'],
  [/^DELETE \/lb\/pools\/[^/]+\/members\//, 'Gỡ backend LB'],
  [/^POST \/lb$/, 'Tạo load balancer'],
  [/^DELETE \/lb\//, 'Xoá load balancer'],
];
function actionLabel(e) {
  const key = `${e.method} ${e.path}`;
  for (const [re, label] of RULES) if (re.test(key)) return label;
  return key;
}

export default function AuditLog() {
  const [entries, setEntries] = useState(null);
  const [q, setQ] = useState('');

  async function load() {
    try { setEntries((await api('/audit?limit=500')).entries); }
    catch (e) { toast(e.message, 'error'); }
  }
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    if (!entries) return null;
    const s = q.trim().toLowerCase();
    if (!s) return entries;
    return entries.filter((e) =>
      (e.user || '').toLowerCase().includes(s) ||
      actionLabel(e).toLowerCase().includes(s) ||
      (e.path || '').toLowerCase().includes(s));
  }, [entries, q]);

  return (
    <>
      <PageHead title="Nhật ký hoạt động" count={filtered?.length} onRefresh={load}>
        <input placeholder="Tìm người dùng / hành động…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 240 }} />
      </PageHead>
      <p className="dim page-desc">Ghi lại các thao tác thay đổi trong project này (500 dòng gần nhất): ai làm, làm gì, lúc nào, thành công hay không. Job backup tự động cũng được ghi.</p>

      {!filtered ? <Empty>Đang tải…</Empty> : filtered.length === 0 ? (
        <Empty>Chưa có hoạt động nào được ghi.</Empty>
      ) : (
        <div className="card">
          <table className="tbl">
            <thead><tr><th>Thời gian</th><th>Người dùng</th><th>Hành động</th><th>Đường dẫn</th><th>Kết quả</th></tr></thead>
            <tbody>
              {filtered.map((e, i) => (
                <tr key={e.ts + i}>
                  <td className="dim" style={{ whiteSpace: 'nowrap' }}>{fmtDate(e.ts)}</td>
                  <td><b>{e.user || '—'}</b></td>
                  <td>{actionLabel(e)}</td>
                  <td className="mono dim" style={{ wordBreak: 'break-all' }}>{e.path}</td>
                  <td>
                    <StatusBadge status={e.status >= 200 && e.status < 300 ? 'ACTIVE' : e.status === 401 || e.status === 403 ? 'ERROR' : e.status >= 400 ? 'ERROR' : String(e.status)} />
                    <span className="dim"> {e.status}{e.ms != null ? ` · ${e.ms}ms` : ''}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
