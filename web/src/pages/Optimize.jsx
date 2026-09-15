import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download } from 'lucide-react';
import { api } from '../api.js';
import { toast, Empty, PageHead } from '../components/ui.jsx';

const LABEL = {
  vm_idle: ['Máy ảo CPU thấp', 'Máy ảo'],
  vm_shutoff: ['Máy ảo tắt lâu ngày', 'Máy ảo'],
  vm_error: ['Máy ảo lỗi', 'Máy ảo'],
  volume_orphan: ['Volume không dùng', 'Ổ đĩa'],
  fip_idle: ['Floating IP rảnh', 'Floating IP'],
  snapshot_old: ['Snapshot quá cũ', 'Snapshot'],
};
const SEV = { high: ['Cao', 'badge-err'], medium: ['Vừa', 'badge-warn'], low: ['Thấp', 'badge-muted'] };
const money = (x) => Number(x || 0).toLocaleString('vi-VN', { maximumFractionDigits: 0 });

export default function Optimize() {
  const [data, setData] = useState(null);
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);

  async function load(d = days) {
    setBusy(true);
    try { setData(await api(`/optimize?days=${d}`)); }
    catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  }
  useEffect(() => { load(); }, []); // eslint-disable-line

  function exportCsv() {
    const head = ['Loai', 'Muc do', 'Ten', 'Chi tiet', `Chi phi/thang (${data.pricing.currency})`, 'Khuyen nghi'];
    const rows = data.findings.map((f) => [LABEL[f.type]?.[0] || f.type, SEV[f.severity][0], f.name, f.detail, f.monthly, f.advice]);
    const csv = '\uFEFF' + [head, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `toi-uu-chi-phi-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <>
      <PageHead title="Tối ưu chi phí" count={data?.findings.length}>
        <span className="dim">Ngưỡng nhàn rỗi</span>
        <select value={days} onChange={(e) => { setDays(Number(e.target.value)); load(Number(e.target.value)); }} style={{ width: 110 }}>
          {[3, 7, 14, 30].map((d) => <option key={d} value={d}>{d} ngày</option>)}
        </select>
        <button className="btn ghost" onClick={() => load()} disabled={busy}>{busy ? 'Đang quét…' : 'Quét lại'}</button>
        {data?.findings.length > 0 && <button className="btn ghost" onClick={exportCsv}><Download size={15} /> CSV</button>}
      </PageHead>
      <p className="dim page-desc">Rà soát tài nguyên đang tiêu tiền mà không tạo giá trị: máy tắt lâu, máy lỗi, volume rời, IP rảnh, snapshot cũ.</p>

      {!data ? <Empty>Đang quét…</Empty> : (
        <>
          <div className="grid-cards">
            <div className="card stat stat-cost">
              <span className="stat-label">Có thể tiết kiệm mỗi tháng</span>
              <span className="stat-val mono">{data.pricing.enabled ? `${money(data.total_monthly)} ${data.pricing.currency}` : '—'}</span>
              <span className="stat-sub dim">{data.pricing.enabled ? `Từ ${data.findings.length} hạng mục` : 'Đặt đơn giá PRICE_* trong .env để hiện số tiền'}</span>
            </div>
            {Object.entries(data.counts).filter(([, n]) => n > 0).map(([k, n]) => (
              <div key={k} className="card stat">
                <span className="stat-label">{LABEL[k]?.[0] || k}</span>
                <span className="stat-val mono">{n}</span>
              </div>
            ))}
          </div>

          {data.findings.length === 0 ? (
            <Empty>Không phát hiện lãng phí nào trong project này. 👍</Empty>
          ) : (
            <div className="card">
              <table className="tbl">
                <thead><tr><th>Mức</th><th>Loại</th><th>Tài nguyên</th><th>Chi tiết</th><th>Chi phí/tháng</th><th>Nên làm gì</th></tr></thead>
                <tbody>
                  {data.findings.map((f, i) => (
                    <tr key={f.id + i}>
                      <td><span className={`badge ${SEV[f.severity][1]}`}><i />{SEV[f.severity][0]}</span></td>
                      <td className="dim">{LABEL[f.type]?.[0] || f.type}</td>
                      <td><b>{f.name}</b></td>
                      <td className="dim">{f.detail}</td>
                      <td className="mono">{data.pricing.enabled ? money(f.monthly) : '—'}</td>
                      <td className="dim">{f.advice}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data.monitor && !data.monitor.enabled && <div className="card notice-card">Chưa bật giám sát VM nên không phát hiện được máy CPU thấp — thêm <span className="mono">OS_TASK_USERNAME/PASSWORD</span> và cấp quyền đọc Nova diagnostics.</div>}
          <p className="dim">{data.note} Xử lý trực tiếp ở các mục <Link to="/instances" className="link">Máy ảo</Link>, <Link to="/volumes" className="link">Ổ đĩa</Link>, <Link to="/floating-ips" className="link">Floating IP</Link>.</p>
        </>
      )}
    </>
  );
}
