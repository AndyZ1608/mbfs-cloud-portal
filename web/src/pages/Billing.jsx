import React, { useEffect, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { Download, Pencil } from 'lucide-react';
import { api, ramGB } from '../api.js';
import { toast, Empty, PageHead } from '../components/ui.jsx';

// ---------- helpers ----------
const iso = (d) => d.toISOString().slice(0, 10);
function presetRange(key) {
  const now = new Date();
  const y = now.getUTCFullYear(); const m = now.getUTCMonth();
  if (key === 'this-month') return { start: iso(new Date(Date.UTC(y, m, 1))), end: iso(now) };
  if (key === 'last-month') return { start: iso(new Date(Date.UTC(y, m - 1, 1))), end: iso(new Date(Date.UTC(y, m, 0))) };
  if (key === '7d') { const s = new Date(now); s.setUTCDate(s.getUTCDate() - 6); return { start: iso(s), end: iso(now) }; }
  if (key === '30d') { const s = new Date(now); s.setUTCDate(s.getUTCDate() - 29); return { start: iso(s), end: iso(now) }; }
  return null;
}
const nf = (x, d = 1) => Number(x || 0).toLocaleString('vi-VN', { maximumFractionDigits: d });
const money = (x) => Number(x || 0).toLocaleString('vi-VN', { maximumFractionDigits: 0 });

const PRESETS = [
  ['this-month', 'Tháng này'],
  ['last-month', 'Tháng trước'],
  ['7d', '7 ngày'],
  ['30d', '30 ngày'],
];

export default function Billing() {
  const { sess } = useOutletContext();
  const [preset, setPreset] = useState('this-month');
  const [range, setRange] = useState(presetRange('this-month'));
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('servers');

  async function load(r = range) {
    setBusy(true);
    try { setData(await api(`/billing?start=${r.start}&end=${r.end}`)); }
    catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  }
  useEffect(() => { load(); }, []); // eslint-disable-line

  function applyPreset(key) {
    setPreset(key);
    const r = presetRange(key);
    setRange(r);
    load(r);
  }

  const p = data?.pricing;
  const s = data?.summary;
  const cur = p?.currency || 'VND';

  // ---------- CSV ----------
  function exportCsv() {
    const L = [];
    L.push(['HOA DON THEO DICH VU', `Ky: ${range.start} -> ${range.end}`, `Project: ${sess.project.name}`]);
    L.push(['Dich vu', 'Loai', 'So luong', 'Don vi', `Don gia (${cur}/gio-don-vi)`, `Thanh tien (${cur})`]);
    for (const sv of data.services) {
      for (const it of sv.items) L.push([sv.label, it.name, it.quantity, it.unit, it.unit_price, it.amount]);
      L.push([sv.label, 'TONG', '', '', '', sv.total]);
    }
    L.push(['', 'TONG CONG', '', '', '', s.total]);
    L.push([]);
    L.push(['MAY AO', 'Trang thai', 'vCPU', 'RAM (MB)', 'Disk local (GB)', 'Gio chay', `Chi phi (${cur})`]);
    for (const x of data.resources.servers) L.push([x.name + (x.ended ? ' (da xoa)' : ''), x.state, x.vcpus, x.memory_mb, x.local_gb, x.hours, x.amount]);
    L.push([]);
    L.push(['VOLUME', 'Trang thai', 'Size (GB)', 'Gio ton tai', 'GB-gio', `Chi phi (${cur})`]);
    for (const x of data.resources.volumes) L.push([x.name, x.status, x.size, x.hours, x.gb_hours, x.amount]);
    L.push([]);
    L.push(['FLOATING IP', 'Dang gan', 'Gio ton tai', `Chi phi (${cur})`]);
    for (const x of data.resources.fips) L.push([x.name, x.attached ? 'co' : 'khong', x.hours, x.amount]);
    const csv = '\uFEFF' + L.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `billing-${range.start}_${range.end}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <>
      <PageHead title="Chi phí & Sử dụng">
        <div className="preset-row">
          {PRESETS.map(([k, label]) => (
            <button key={k} className={`preset ${preset === k ? 'active' : ''}`} onClick={() => applyPreset(k)}>{label}</button>
          ))}
        </div>
        <input type="date" value={range.start} onChange={(e) => { setPreset(''); setRange({ ...range, start: e.target.value }); }} style={{ width: 145 }} />
        <span className="dim">→</span>
        <input type="date" value={range.end} onChange={(e) => { setPreset(''); setRange({ ...range, end: e.target.value }); }} style={{ width: 145 }} />
        <button className="btn primary" onClick={() => load()} disabled={busy}>{busy ? 'Đang tính…' : 'Xem'}</button>
        {data && <button className="btn ghost" onClick={exportCsv}><Download size={15} /> CSV</button>}
      </PageHead>

      {!data ? <Empty>Đang tải…</Empty> : (
        <>
          <SummaryCards data={data} projectId={sess.project.id} />
          {p.enabled
            ? <DailyChart daily={data.daily} currency={cur} />
            : (
              <div className="card notice-card">
                Chưa cấu hình đơn giá nên chỉ hiển thị <b>số lượng sử dụng</b>. Đặt trong <span className="mono">.env</span>:{' '}
                <span className="mono">PRICE_VCPU_HOUR, PRICE_RAM_GB_HOUR, PRICE_DISK_GB_HOUR, PRICE_VOLUME_GB_HOUR, PRICE_SNAPSHOT_GB_HOUR, PRICE_FIP_HOUR</span> (đơn vị {cur}/giờ) rồi restart portal.
              </div>
            )}
          <ServiceBill services={data.services} pricing={p} total={s.total} />
          <ResourceTables data={data} tab={tab} setTab={setTab} pricing={p} />
          {data.period.capped_to_now && <p className="dim">Kỳ chưa kết thúc — số liệu tính đến thời điểm hiện tại (UTC). {data.notes.deleted_storage_not_counted}</p>}
        </>
      )}
    </>
  );
}

// ---------- Summary cards (kiểu Cost Explorer) ----------
function SummaryCards({ data, projectId }) {
  const p = data.pricing; const s = data.summary;
  const cur = p.currency;
  const budgetKey = `mbfs-budget-${projectId}`;
  const [budget, setBudget] = useState(() => Number(localStorage.getItem(budgetKey)) || 0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  function saveBudget() {
    const v = Math.max(0, Number(draft) || 0);
    setBudget(v);
    localStorage.setItem(budgetKey, String(v));
    setEditing(false);
  }
  const vsBudget = budget > 0 ? Math.round(((s.forecast?.total ?? s.total) / budget) * 100) : 0;

  return (
    <div className="grid-cards">
      <div className="card stat">
        <span className="stat-label">{p.enabled ? 'Chi phí kỳ này' : 'Tổng giờ chạy máy ảo'}</span>
        <span className="stat-val mono">{p.enabled ? `${money(s.total)} ${cur}` : `${nf(s.usage.server_hours)} h`}</span>
        {p.enabled && (
          <span className="stat-sub dim">
            Compute {money(s.by_service.compute)} · Storage {money(s.by_service.storage)} · Network {money(s.by_service.network)}
          </span>
        )}
      </div>
      <div className="card stat">
        <span className="stat-label">Dự báo hết kỳ</span>
        {s.forecast
          ? <><span className="stat-val mono">{money(s.forecast.total)} {cur}</span><span className="stat-sub dim">Đã qua {s.forecast.elapsed_pct}% kỳ — ngoại suy theo mức chi hiện tại</span></>
          : <span className="stat-val dim" style={{ fontSize: 15 }}>{p.enabled ? 'Kỳ đã kết thúc' : '—'}</span>}
      </div>
      <div className="card stat">
        <span className="stat-label">Ngân sách kỳ <button className="icon-btn" onClick={() => { setDraft(budget || ''); setEditing(!editing); }} title="Sửa ngân sách"><Pencil size={13} /></button></span>
        {editing ? (
          <span className="row-inline">
            <input type="number" min="0" value={draft} onChange={(e) => setDraft(e.target.value)} style={{ width: 140 }} autoFocus
              onKeyDown={(e) => e.key === 'Enter' && saveBudget()} />
            <button className="btn sm primary" onClick={saveBudget}>Lưu</button>
          </span>
        ) : budget > 0 ? (
          <>
            <span className="stat-val mono">{money(budget)} {cur}</span>
            <div className="usage-track" style={{ marginTop: 6 }}>
              <div className={`usage-fill ${vsBudget >= 100 ? 'fill-err' : vsBudget >= 80 ? 'fill-warn' : 'fill-ok'}`} style={{ width: Math.min(100, vsBudget) + '%' }} />
            </div>
            <span className={`stat-sub ${vsBudget >= 100 ? 'err-text' : 'dim'}`}>{vsBudget}% ngân sách ({s.forecast ? 'theo dự báo' : 'thực tế'})</span>
          </>
        ) : <span className="stat-val dim" style={{ fontSize: 15 }}>Chưa đặt — bấm ✎ <span className="stat-sub dim" style={{ display: 'block' }}>Lưu trong trình duyệt này</span></span>}
      </div>
      <div className="card stat">
        <span className="stat-label">Sử dụng compute</span>
        <span className="stat-val mono">{nf(s.usage.vcpu_hours, 0)} vCPU-giờ</span>
        <span className="stat-sub dim">{nf(s.usage.ram_gb_hours, 0)} RAM GB-giờ · {nf(s.usage.server_hours, 0)} giờ chạy</span>
      </div>
    </div>
  );
}

// ---------- Biểu đồ cột chồng theo ngày (SVG thuần) ----------
const SERIES = [
  ['compute', 'Compute', 'var(--accent)'],
  ['storage', 'Storage', '#1e8e4e'],
  ['network', 'Network', '#b57d0f'],
];
function DailyChart({ daily, currency }) {
  const H = 190; const padL = 56; const padB = 26; const padT = 12;
  const n = daily.length;
  const bw = 18; const gap = 7;
  const W = padL + n * (bw + gap) + 14;
  const max = Math.max(...daily.map((d) => d.total), 1);
  const yScale = (v) => (H - padB) - (v / max) * (H - padB - padT);
  const ticks = [0, 0.5, 1].map((f) => r2c(max * f));
  const labelEvery = Math.max(1, Math.ceil(n / 9));

  function r2c(v) { // làm tròn tick đẹp
    if (v === 0) return 0;
    const pow = Math.pow(10, Math.floor(Math.log10(v)));
    return Math.round(v / pow) * pow;
  }
  const short = (v) => v >= 1e9 ? nf(v / 1e9, 1) + ' tỷ' : v >= 1e6 ? nf(v / 1e6, 1) + ' tr' : v >= 1e3 ? nf(v / 1e3, 0) + ' k' : nf(v, 0);

  return (
    <div className="card">
      <div className="card-head">
        <h4>Chi phí theo ngày ({currency})</h4>
        <div className="legend">
          {SERIES.map(([k, label, color]) => <span key={k} className="legend-item"><i style={{ background: color }} />{label}</span>)}
        </div>
      </div>
      <div className="chart-scroll">
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label="Biểu đồ chi phí theo ngày">
          {ticks.map((t, i) => (
            <g key={i}>
              <line x1={padL} x2={W - 6} y1={yScale(t)} y2={yScale(t)} stroke="#e3e8f0" strokeDasharray={t === 0 ? '' : '3 3'} />
              <text x={padL - 7} y={yScale(t) + 4} textAnchor="end" fontSize="10" fill="#6b7688">{short(t)}</text>
            </g>
          ))}
          {daily.map((d, i) => {
            const x = padL + i * (bw + gap);
            let y = H - padB;
            const segs = SERIES.map(([k, label, color]) => {
              const h = ((d[k] || 0) / max) * (H - padB - padT);
              y -= h;
              return <rect key={k} x={x} y={y} width={bw} height={Math.max(0, h)} fill={color} rx="1.5" />;
            });
            return (
              <g key={d.date}>
                <title>{`${d.date}\nCompute: ${nf(d.compute, 0)}\nStorage: ${nf(d.storage, 0)}\nNetwork: ${nf(d.network, 0)}\nTổng: ${nf(d.total, 0)} ${currency}`}</title>
                {segs}
                {i % labelEvery === 0 && (
                  <text x={x + bw / 2} y={H - 8} textAnchor="middle" fontSize="10" fill="#6b7688">{d.date.slice(8, 10)}/{d.date.slice(5, 7)}</text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

// ---------- Hoá đơn theo dịch vụ (kiểu AWS Bills) ----------
function ServiceBill({ services, pricing, total }) {
  const [open, setOpen] = useState({ compute: true, storage: true, network: true });
  const cur = pricing.currency;
  return (
    <div className="card">
      <div className="card-head"><h4>{pricing.enabled ? 'Hoá đơn theo dịch vụ' : 'Sử dụng theo dịch vụ'}</h4></div>
      <table className="tbl bill-tbl">
        <thead>
          <tr><th style={{ width: '34%' }}>Dịch vụ / Loại</th><th>Số lượng</th><th>Đơn vị</th>
            {pricing.enabled && <><th>Đơn giá ({cur}/giờ·đv)</th><th className="t-right">Thành tiền ({cur})</th></>}
          </tr>
        </thead>
        <tbody>
          {services.map((sv) => (
            <React.Fragment key={sv.key}>
              <tr className="bill-svc" onClick={() => setOpen({ ...open, [sv.key]: !open[sv.key] })}>
                <td><span className="caret">{open[sv.key] ? '▾' : '▸'}</span> <b>{sv.label}</b></td>
                <td /><td />
                {pricing.enabled && <><td /><td className="t-right mono"><b>{money(sv.total)}</b></td></>}
              </tr>
              {open[sv.key] && sv.items.map((it) => (
                <tr key={it.name} className="bill-item">
                  <td className="bill-indent">{it.name}</td>
                  <td className="mono">{nf(it.quantity)}</td>
                  <td className="dim">{it.unit}</td>
                  {pricing.enabled && <><td className="mono">{it.unit_price ? money(it.unit_price) : <span className="dim">—</span>}</td>
                    <td className="t-right mono">{money(it.amount)}</td></>}
                </tr>
              ))}
            </React.Fragment>
          ))}
          {pricing.enabled && (
            <tr className="bill-total">
              <td><b>TỔNG CỘNG</b></td><td /><td /><td />
              <td className="t-right mono"><b>{money(total)} {cur}</b></td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ---------- Chi tiết theo tài nguyên ----------
function ResourceTables({ data, tab, setTab, pricing }) {
  const cur = pricing.currency;
  const r = data.resources;
  const TABS = [
    ['servers', `Máy ảo (${r.servers.length})`],
    ['volumes', `Volume (${r.volumes.length})`],
    ['snapshots', `Snapshot (${r.snapshots.length})`],
    ['fips', `Floating IP (${r.fips.length})`],
  ];
  return (
    <div className="card">
      <div className="tab-row">
        {TABS.map(([k, label]) => <button key={k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{label}</button>)}
      </div>
      {tab === 'servers' && (
        r.servers.length === 0 ? <Empty>Không có máy ảo trong kỳ.</Empty> :
        <table className="tbl">
          <thead><tr><th>Máy ảo</th><th>Trạng thái</th><th>Cấu hình</th><th>Giờ chạy</th><th>vCPU-giờ</th>{pricing.enabled && <th className="t-right">Chi phí ({cur})</th>}</tr></thead>
          <tbody>{r.servers.map((x, i) => (
            <tr key={x.name + i}>
              <td><b>{x.name}</b>{x.ended && <span className="dim"> (đã xoá)</span>}</td>
              <td className="dim">{x.state}</td>
              <td className="dim">{x.vcpus} vCPU / {ramGB(x.memory_mb)} / {x.local_gb} GB</td>
              <td className="mono">{nf(x.hours)}</td>
              <td className="mono">{nf(x.vcpus * x.hours)}</td>
              {pricing.enabled && <td className="t-right mono">{money(x.amount)}</td>}
            </tr>
          ))}</tbody>
        </table>
      )}
      {tab === 'volumes' && (
        r.volumes.length === 0 ? <Empty>Không có volume.</Empty> :
        <table className="tbl">
          <thead><tr><th>Volume</th><th>Trạng thái</th><th>Size</th><th>Giờ tồn tại</th><th>GB-giờ</th>{pricing.enabled && <th className="t-right">Chi phí ({cur})</th>}</tr></thead>
          <tbody>{r.volumes.map((x, i) => (
            <tr key={x.name + i}><td><b>{x.name}</b></td><td className="dim">{x.status}</td><td className="mono">{x.size} GB</td>
              <td className="mono">{nf(x.hours)}</td><td className="mono">{nf(x.gb_hours, 0)}</td>
              {pricing.enabled && <td className="t-right mono">{money(x.amount)}</td>}</tr>
          ))}</tbody>
        </table>
      )}
      {tab === 'snapshots' && (
        r.snapshots.length === 0 ? <Empty>Không có snapshot.</Empty> :
        <table className="tbl">
          <thead><tr><th>Snapshot</th><th>Size</th><th>Giờ tồn tại</th><th>GB-giờ</th>{pricing.enabled && <th className="t-right">Chi phí ({cur})</th>}</tr></thead>
          <tbody>{r.snapshots.map((x, i) => (
            <tr key={x.name + i}><td><b>{x.name}</b></td><td className="mono">{x.size} GB</td>
              <td className="mono">{nf(x.hours)}</td><td className="mono">{nf(x.gb_hours, 0)}</td>
              {pricing.enabled && <td className="t-right mono">{money(x.amount)}</td>}</tr>
          ))}</tbody>
        </table>
      )}
      {tab === 'fips' && (
        r.fips.length === 0 ? <Empty>Không có Floating IP.</Empty> :
        <table className="tbl">
          <thead><tr><th>Địa chỉ IP</th><th>Đang gắn</th><th>Giờ tồn tại</th>{pricing.enabled && <th className="t-right">Chi phí ({cur})</th>}</tr></thead>
          <tbody>{r.fips.map((x, i) => (
            <tr key={x.name + i}><td className="mono"><b>{x.name}</b></td><td className="dim">{x.attached ? 'Có' : 'Không (vẫn tính phí)'}</td>
              <td className="mono">{nf(x.hours)}</td>
              {pricing.enabled && <td className="t-right mono">{money(x.amount)}</td>}</tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}
