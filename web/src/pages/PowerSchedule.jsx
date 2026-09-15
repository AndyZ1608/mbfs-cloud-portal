import React, { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { api, fmtDate } from '../api.js';
import { Modal, Field, StatusBadge, ActionsMenu, toast, Empty, PageHead } from '../components/ui.jsx';

const WD = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
const hhmm = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

export default function PowerSchedule() {
  const [data, setData] = useState(null);
  const [creating, setCreating] = useState(false);

  async function load() {
    try { setData(await api('/power/rules')); }
    catch (e) { toast(e.message, 'error'); }
  }
  useEffect(() => { load(); }, []);

  async function toggle(r) {
    try { await api(`/power/rules/${r.id}`, { method: 'PATCH', body: { enabled: !r.enabled } }); load(); }
    catch (e) { toast(e.message, 'error'); }
  }
  async function del(r) {
    if (!window.confirm(`Xoá quy tắc ${r.action === 'stop' ? 'tắt' : 'bật'} máy "${r.server_name}"?`)) return;
    try { await api(`/power/rules/${r.id}`, { method: 'DELETE' }); toast('Đã xoá quy tắc', 'ok'); load(); }
    catch (e) { toast(e.message, 'error'); }
  }

  return (
    <>
      <PageHead title="Lịch bật/tắt máy ảo" count={data?.rules.length} onRefresh={load}>
        <button className="btn primary" onClick={() => setCreating(true)} disabled={data && !data.configured}><Plus size={16} /> Tạo quy tắc</button>
      </PageHead>
      <p className="dim page-desc">Tự động tắt máy dev/test ngoài giờ và bật lại đầu giờ làm việc — cách giảm chi phí nhanh nhất mà không phải xoá gì. Giờ chạy theo múi giờ {data?.tz || '…'}.</p>

      {data && !data.configured && (
        <div className="card notice-card">
          Chưa cấu hình <b>tài khoản dịch vụ</b> nên lịch không chạy được. Thêm <span className="mono">OS_TASK_USERNAME</span> / <span className="mono">OS_TASK_PASSWORD</span> vào <span className="mono">.env</span> rồi restart portal.
        </div>
      )}

      {!data ? <Empty>Đang tải…</Empty> : data.rules.length === 0 ? (
        <Empty>Chưa có quy tắc nào. Ví dụ phổ biến: tắt 19:00 T2–T6, bật 07:30 T2–T6 → máy chỉ chạy ~40% thời gian.</Empty>
      ) : (
        <div className="card">
          <table className="tbl">
            <thead><tr><th>Máy ảo</th><th>Hành động</th><th>Thời điểm</th><th>Ngày trong tuần</th><th>Trạng thái</th><th>Chạy gần nhất</th><th /></tr></thead>
            <tbody>
              {data.rules.map((r) => (
                <tr key={r.id}>
                  <td><b>{r.server_name}</b></td>
                  <td><span className={`chip ${r.action === 'stop' ? '' : 'chip-fip'}`}>{r.action === 'stop' ? 'Tắt máy' : 'Bật máy'}</span></td>
                  <td className="mono">{hhmm(r.schedule.hour, r.schedule.minute)}</td>
                  <td>{r.schedule.days.map((d) => <span key={d} className="chip">{WD[d]}</span>)}</td>
                  <td>
                    <label className="check-item">
                      <input type="checkbox" checked={r.enabled} onChange={() => toggle(r)} />{r.enabled ? 'Đang bật' : 'Tạm dừng'}
                    </label>
                  </td>
                  <td>{r.last_run
                    ? <span title={r.last_run.message}><StatusBadge status={r.last_run.status === 'ok' ? 'ACTIVE' : 'ERROR'} /> <span className="dim">{fmtDate(r.last_run.ts)}</span></span>
                    : <span className="dim">Chưa chạy</span>}</td>
                  <td><ActionsMenu items={[{ label: 'Xoá quy tắc', danger: true, onClick: () => del(r) }]} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && <CreateRule onClose={() => setCreating(false)} onDone={() => { setCreating(false); load(); }} />}
    </>
  );
}

function CreateRule({ onClose, onDone }) {
  const [servers, setServers] = useState([]);
  const [f, setF] = useState({ server_id: '', preset: 'office', days: [1, 2, 3, 4, 5], stop_time: '19:00', start_time: '07:30' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/servers').then((d) => { setServers(d.servers); setF((x) => ({ ...x, server_id: d.servers[0]?.id || '' })); })
      .catch((e) => toast(e.message, 'error'));
  }, []);

  const toggleDay = (d) => setF((x) => ({ ...x, days: x.days.includes(d) ? x.days.filter((y) => y !== d) : [...x.days, d].sort() }));

  async function submit() {
    if (!f.server_id) return toast('Chọn máy ảo', 'error');
    if (!f.days.length) return toast('Chọn ít nhất một ngày', 'error');
    const srv = servers.find((s) => s.id === f.server_id);
    setBusy(true);
    try {
      const mk = (action, time) => {
        const [hour, minute] = time.split(':').map(Number);
        return api('/power/rules', { method: 'POST', body: { server_id: f.server_id, server_name: srv.name, action, days: f.days, hour, minute } });
      };
      if (f.preset !== 'start_only') await mk('stop', f.stop_time);
      if (f.preset !== 'stop_only') await mk('start', f.start_time);
      toast('Đã tạo lịch', 'ok');
      onDone();
    } catch (e) { toast(e.message, 'error'); setBusy(false); }
  }

  return (
    <Modal title="Tạo lịch bật/tắt" onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Huỷ</button>
        <button className="btn primary" onClick={submit} disabled={busy}>{busy ? 'Đang tạo…' : 'Tạo lịch'}</button></>}>
      <Field label="Máy ảo">
        <select value={f.server_id} onChange={(e) => setF({ ...f, server_id: e.target.value })}>
          {servers.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.status})</option>)}
        </select>
      </Field>
      <Field label="Kiểu lịch">
        <select value={f.preset} onChange={(e) => setF({ ...f, preset: e.target.value })}>
          <option value="office">Tắt ngoài giờ + bật đầu giờ (2 quy tắc)</option>
          <option value="stop_only">Chỉ tắt</option>
          <option value="start_only">Chỉ bật</option>
        </select>
      </Field>
      <div className="row-inline">
        {f.preset !== 'start_only' && <Field label="Giờ tắt"><input type="time" value={f.stop_time} onChange={(e) => setF({ ...f, stop_time: e.target.value })} /></Field>}
        {f.preset !== 'stop_only' && <Field label="Giờ bật"><input type="time" value={f.start_time} onChange={(e) => setF({ ...f, start_time: e.target.value })} /></Field>}
      </div>
      <Field label="Ngày trong tuần">
        <div className="row-inline" style={{ flexWrap: 'wrap' }}>
          {WD.map((label, d) => (
            <button key={d} type="button" className={`preset ${f.days.includes(d) ? 'active' : ''}`} onClick={() => toggleDay(d)}>{label}</button>
          ))}
        </div>
      </Field>
      <p className="dim">Máy đang tắt sẵn thì lệnh tắt bị bỏ qua (Nova báo lỗi nhẹ, ghi vào lần chạy gần nhất) — không ảnh hưởng gì.</p>
    </Modal>
  );
}
