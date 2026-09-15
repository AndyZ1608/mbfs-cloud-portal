import React, { useEffect, useState } from 'react';
import { api, fmtBytes } from '../api.js';
import { Modal, toast } from './ui.jsx';

// Biểu đồ đường SVG thuần — không thêm thư viện
function LineChart({ points, color = 'var(--accent)', fmt = (v) => v, unit = '' }) {
  const W = 560, H = 110, padL = 46, padB = 16, padT = 8;
  if (!points.length) return <div className="dim" style={{ padding: '20px 0' }}>Chưa có dữ liệu.</div>;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1] ?? 0);
  const x0 = Math.min(...xs), x1 = Math.max(...xs) || x0 + 1;
  const yMax = Math.max(...ys, 1);
  const X = (t) => padL + ((t - x0) / (x1 - x0 || 1)) * (W - padL - 8);
  const Y = (v) => H - padB - (v / yMax) * (H - padB - padT);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1] ?? 0).toFixed(1)}`).join(' ');
  const area = `${line} L${X(x1).toFixed(1)},${H - padB} L${X(x0).toFixed(1)},${H - padB} Z`;
  const tLabel = (t) => new Date(t).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img">
      {[0.5, 1].map((f) => (
        <g key={f}>
          <line x1={padL} x2={W - 8} y1={Y(yMax * f)} y2={Y(yMax * f)} stroke="#e3e8f0" strokeDasharray="3 3" />
          <text x={padL - 5} y={Y(yMax * f) + 4} textAnchor="end" fontSize="9.5" fill="#6b7688">{fmt(yMax * f)}{unit}</text>
        </g>
      ))}
      <path d={area} fill={color} opacity="0.12" />
      <path d={line} fill="none" stroke={color} strokeWidth="1.8" />
      <text x={padL} y={H - 3} fontSize="9.5" fill="#6b7688">{tLabel(x0)}</text>
      <text x={W - 8} y={H - 3} textAnchor="end" fontSize="9.5" fill="#6b7688">{tLabel(x1)}</text>
    </svg>
  );
}

const RANGES = [[1, '1 giờ'], [6, '6 giờ'], [24, '24 giờ']];
const bps = (v) => (v >= 1048576 ? (v / 1048576).toFixed(1) + ' MB' : v >= 1024 ? Math.round(v / 1024) + ' KB' : Math.round(v) + ' B');

export default function MonitorModal({ server, status, onClose }) {
  const [hours, setHours] = useState(6);
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    setData(null); setErr('');
    api(`/monitor/servers/${server.id}?hours=${hours}`)
      .then(setData)
      .catch((e) => setErr(e.message));
  }, [server.id, hours]);

  const S = data?.samples || [];
  const pick = (i) => S.map((s) => [s[0], s[i]]);
  const last = S[S.length - 1];
  const memPts = S.filter((s) => s[2] != null && s[3]).map((s) => [s[0], Math.round((s[2] / s[3]) * 100)]);
  const extUrl = status?.url_template
    ? status.url_template.replaceAll('{name}', server.name).replaceAll('{id}', server.id)
    : null;

  return (
    <Modal title={`Giám sát — ${server.name}`} onClose={onClose} wide
      footer={extUrl && <a className="btn ghost" href={extUrl} target="_blank" rel="noreferrer">Mở hệ thống giám sát ngoài ↗</a>}>
      <div className="row-inline" style={{ marginBottom: 10, justifyContent: 'space-between' }}>
        <div className="tab-row" style={{ marginBottom: 0 }}>
          {RANGES.map(([h, label]) => (
            <button key={h} className={`tab ${hours === h ? 'active' : ''}`} onClick={() => setHours(h)}>{label}</button>
          ))}
        </div>
        {last && (
          <span className="dim">
            Hiện tại: <b className="mono">{last[1]}% CPU</b>
            {last[2] != null && last[3] ? <> · <b className="mono">{Math.round((last[2] / last[3]) * 100)}% RAM</b> ({last[2]}/{last[3]} MB)</> : null}
          </span>
        )}
      </div>

      {err ? <p className="warn-text">{err}</p> : !data ? <p>Đang tải…</p> : (
        <>
          <h4 className="chart-title">CPU (%)</h4>
          <LineChart points={pick(1)} unit="%" fmt={(v) => Math.round(v)} />
          <h4 className="chart-title">RAM (%)</h4>
          {memPts.length ? <LineChart points={memPts} color="#1e8e4e" unit="%" fmt={(v) => Math.round(v)} />
            : <p className="dim">Hypervisor không báo RAM thực dùng (VM cần memballoon/qemu-guest-agent) — bỏ qua biểu đồ này.</p>}
          <h4 className="chart-title">Mạng (nhận ↓ / gửi ↑ mỗi giây)</h4>
          <LineChart points={pick(4)} color="#b57d0f" fmt={bps} unit="/s" />
          <LineChart points={pick(5)} color="#2c6cb0" fmt={bps} unit="/s" />
          <h4 className="chart-title">Đĩa (đọc / ghi mỗi giây)</h4>
          <LineChart points={pick(6)} color="#7a5cc9" fmt={bps} unit="/s" />
          <LineChart points={pick(7)} color="#c23b6f" fmt={bps} unit="/s" />
          <p className="dim">Lấy mẫu mỗi {status?.interval_sec || 120}s từ Nova diagnostics (libvirt) — không cần agent trong VM.</p>
        </>
      )}
    </Modal>
  );
}
