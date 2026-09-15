import React, { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { api, fmtDate } from '../api.js';
import { Modal, Field, StatusBadge, ActionsMenu, toast, Empty, PageHead } from '../components/ui.jsx';

const WD = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];
const hhmm = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
const schedText = (s) => s.freq === 'daily' ? `Hàng ngày lúc ${hhmm(s.hour, s.minute)}` : `${WD[s.weekday]} hàng tuần lúc ${hhmm(s.hour, s.minute)}`;

export default function Backup() {
  const [status, setStatus] = useState(null);
  const [policies, setPolicies] = useState(null);
  const [creating, setCreating] = useState(false);
  const [runningId, setRunningId] = useState(null);

  async function load() {
    try {
      const [st, po] = await Promise.all([api('/backup/status'), api('/backup/policies')]);
      setStatus(st); setPolicies(po.policies);
    } catch (e) { toast(e.message, 'error'); }
  }
  useEffect(() => { load(); }, []);

  async function toggle(p) {
    try {
      await api(`/backup/policies/${p.id}`, { method: 'PATCH', body: { enabled: !p.enabled } });
      toast(p.enabled ? 'Đã tạm dừng policy' : 'Đã bật policy', 'ok');
      load();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function runNow(p) {
    setRunningId(p.id);
    try {
      const r = await api(`/backup/policies/${p.id}/run`, { method: 'POST' });
      toast(r.last_run?.message || 'Đã chạy backup', 'ok');
      load();
    } catch (e) { toast(e.message, 'error'); }
    setRunningId(null);
  }

  async function del(p) {
    if (!window.confirm(`Xoá policy backup "${p.target_name}"? Các bản backup đã tạo sẽ giữ nguyên.`)) return;
    try { await api(`/backup/policies/${p.id}`, { method: 'DELETE' }); toast('Đã xoá policy', 'ok'); load(); }
    catch (e) { toast(e.message, 'error'); }
  }

  return (
    <>
      <PageHead title="Backup tự động" count={policies?.length} onRefresh={load}>
        <button className="btn primary" onClick={() => setCreating(true)} disabled={status && !status.configured}><Plus size={16} /> Tạo policy</button>
      </PageHead>
      <p className="dim page-desc">Tự động snapshot volume hoặc tạo image máy ảo theo lịch, tự xoá bản cũ theo số lượng giữ lại. Giờ chạy theo múi giờ {status?.tz || '…'} của server.</p>

      {status && !status.configured && (
        <div className="card notice-card">
          Chưa cấu hình <b>tài khoản dịch vụ</b> nên lịch backup không chạy được. Thêm vào <span className="mono">.env</span>:{' '}
          <span className="mono">OS_TASK_USERNAME, OS_TASK_PASSWORD</span> (user Keystone có role <span className="mono">member</span> trên các project cần backup) rồi restart portal.
        </div>
      )}
      {status && status.configured && !status.persistent && (
        <div className="card notice-card">
          <b>Cảnh báo:</b> thư mục <span className="mono">/data</span> không ghi được — policy sẽ mất khi restart container. Kiểm tra volume <span className="mono">portal-data:/data</span> trong docker-compose.yml.
        </div>
      )}

      {!policies ? <Empty>Đang tải…</Empty> : policies.length === 0 ? (
        <Empty>Chưa có policy nào. Tạo policy để backup định kỳ volume hoặc máy ảo quan trọng.</Empty>
      ) : (
        <div className="card">
          <table className="tbl">
            <thead><tr><th>Tài nguyên</th><th>Lịch chạy</th><th>Giữ lại</th><th>Trạng thái</th><th>Lần chạy gần nhất</th><th /></tr></thead>
            <tbody>
              {policies.map((p) => (
                <tr key={p.id}>
                  <td>
                    <span className={`chip ${p.type === 'volume' ? '' : 'chip-fip'}`}>{p.type === 'volume' ? 'Volume' : 'Máy ảo'}</span>{' '}
                    <b>{p.target_name}</b>
                  </td>
                  <td>{schedText(p.schedule)}</td>
                  <td className="mono">{p.retention} bản</td>
                  <td>
                    <label className="check-item">
                      <input type="checkbox" checked={p.enabled} onChange={() => toggle(p)} />
                      {p.enabled ? 'Đang bật' : 'Tạm dừng'}
                    </label>
                  </td>
                  <td>
                    {p.last_run ? (
                      <span title={p.last_run.message}>
                        <StatusBadge status={p.last_run.status === 'ok' ? 'ACTIVE' : 'ERROR'} />{' '}
                        <span className="dim">{fmtDate(p.last_run.ts)}</span>
                      </span>
                    ) : <span className="dim">Chưa chạy</span>}
                  </td>
                  <td>
                    <ActionsMenu items={[
                      { label: runningId === p.id ? 'Đang chạy…' : 'Chạy ngay', disabled: runningId === p.id || !status?.configured, onClick: () => runNow(p) },
                      'divider',
                      { label: 'Xoá policy', danger: true, onClick: () => del(p) },
                    ]} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && <CreatePolicy onClose={() => setCreating(false)} onDone={() => { setCreating(false); load(); }} />}
    </>
  );
}

function CreatePolicy({ onClose, onDone }) {
  const [targets, setTargets] = useState({ volumes: [], servers: [] });
  const [f, setF] = useState({ type: 'volume', target_id: '', freq: 'daily', weekday: 1, time: '02:00', retention: 7 });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([api('/volumes'), api('/servers')]).then(([v, s]) => {
      setTargets({ volumes: v.volumes, servers: s.servers });
      setF((x) => ({ ...x, target_id: v.volumes[0]?.id || '' }));
    }).catch((e) => toast(e.message, 'error'));
  }, []);

  const list = f.type === 'volume' ? targets.volumes : targets.servers;

  function setType(type) {
    const l = type === 'volume' ? targets.volumes : targets.servers;
    setF({ ...f, type, target_id: l[0]?.id || '' });
  }

  async function submit() {
    if (!f.target_id) return toast('Chọn tài nguyên cần backup', 'error');
    const [hour, minute] = f.time.split(':').map(Number);
    const target = list.find((x) => x.id === f.target_id);
    setBusy(true);
    try {
      await api('/backup/policies', {
        method: 'POST',
        body: {
          type: f.type, target_id: f.target_id,
          target_name: target?.name || f.target_id.slice(0, 8),
          schedule: { freq: f.freq, hour, minute, weekday: f.freq === 'weekly' ? Number(f.weekday) : undefined },
          retention: Number(f.retention),
        },
      });
      toast('Đã tạo policy backup', 'ok');
      onDone();
    } catch (e) { toast(e.message, 'error'); setBusy(false); }
  }

  return (
    <Modal title="Tạo policy backup" onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Huỷ</button>
        <button className="btn primary" onClick={submit} disabled={busy}>{busy ? 'Đang tạo…' : 'Tạo policy'}</button></>}>
      <Field label="Loại backup">
        <div className="tab-row" style={{ marginBottom: 0 }}>
          <button className={`tab ${f.type === 'volume' ? 'active' : ''}`} onClick={() => setType('volume')}>Snapshot volume</button>
          <button className={`tab ${f.type === 'server' ? 'active' : ''}`} onClick={() => setType('server')}>Image máy ảo</button>
        </div>
      </Field>
      <Field label={f.type === 'volume' ? 'Volume' : 'Máy ảo'}>
        <select value={f.target_id} onChange={(e) => setF({ ...f, target_id: e.target.value })}>
          {list.map((x) => <option key={x.id} value={x.id}>{x.name || x.id.slice(0, 8)}{f.type === 'volume' ? ` (${x.size} GB)` : ''}</option>)}
        </select>
        {list.length === 0 && <span className="field-hint">Không có {f.type === 'volume' ? 'volume' : 'máy ảo'} nào trong project.</span>}
      </Field>
      <div className="row-inline">
        <Field label="Tần suất">
          <select value={f.freq} onChange={(e) => setF({ ...f, freq: e.target.value })}>
            <option value="daily">Hàng ngày</option>
            <option value="weekly">Hàng tuần</option>
          </select>
        </Field>
        {f.freq === 'weekly' && (
          <Field label="Vào thứ">
            <select value={f.weekday} onChange={(e) => setF({ ...f, weekday: e.target.value })}>
              {WD.map((d, i) => <option key={i} value={i}>{d}</option>)}
            </select>
          </Field>
        )}
        <Field label="Giờ chạy"><input type="time" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} /></Field>
      </div>
      <Field label="Số bản giữ lại" hint="Bản cũ hơn sẽ tự bị xoá sau mỗi lần backup thành công (1–90)">
        <input type="number" min="1" max="90" value={f.retention} onChange={(e) => setF({ ...f, retention: e.target.value })} />
      </Field>
      {f.type === 'server' && <p className="dim">Image máy ảo chụp đĩa gốc; máy boot-from-volume nên dùng snapshot volume thay thế.</p>}
    </Modal>
  );
}
