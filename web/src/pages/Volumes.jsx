import React, { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { api, fmtDate } from '../api.js';
import { Modal, Field, StatusBadge, ActionsMenu, toast, Empty, PageHead } from '../components/ui.jsx';

export default function Volumes() {
  const [vols, setVols] = useState(null);
  const [snaps, setSnaps] = useState([]);
  const [servers, setServers] = useState([]);
  const [creating, setCreating] = useState(false);
  const [attachFor, setAttachFor] = useState(null);
  const timer = useRef(null);

  async function load() {
    try {
      const [v, s, sv] = await Promise.all([api('/volumes'), api('/snapshots'), api('/servers')]);
      setVols(v.volumes); setSnaps(s.snapshots); setServers(sv.servers);
    } catch (e) { toast(e.message, 'error'); }
  }
  useEffect(() => {
    load();
    timer.current = setInterval(load, 15000);
    return () => clearInterval(timer.current);
  }, []);

  const serverName = (id) => servers.find((s) => s.id === id)?.name || id?.slice(0, 8);

  async function del(v) {
    if (!window.confirm(`Xoá volume "${v.name || v.id.slice(0, 8)}" (${v.size} GB)?`)) return;
    try { await api(`/volumes/${v.id}`, { method: 'DELETE' }); toast('Đã xoá volume', 'ok'); load(); }
    catch (e) { toast(e.message, 'error'); }
  }

  async function detach(v) {
    const sid = v.attachments?.[0]?.server_id;
    if (!sid) return;
    if (!window.confirm(`Tháo volume khỏi máy "${serverName(sid)}"? Hãy umount trong OS trước.`)) return;
    try { await api(`/volumes/${v.id}/detach`, { method: 'POST', body: { server_id: sid } }); toast('Đang tháo volume…', 'ok'); setTimeout(load, 1000); }
    catch (e) { toast(e.message, 'error'); }
  }

  async function extend(v) {
    const ns = window.prompt(`Dung lượng mới (GB, hiện tại ${v.size} GB):`, String(v.size + 10));
    if (!ns) return;
    if (Number(ns) <= v.size) return toast('Dung lượng mới phải lớn hơn hiện tại', 'error');
    try { await api(`/volumes/${v.id}/extend`, { method: 'POST', body: { new_size: Number(ns) } }); toast('Đang mở rộng volume…', 'ok'); setTimeout(load, 1000); }
    catch (e) { toast(e.message, 'error'); }
  }

  async function snapshot(v) {
    const name = window.prompt('Tên snapshot:', `${v.name || 'vol'}-snap-${new Date().toISOString().slice(0, 10)}`);
    if (!name) return;
    try { await api('/snapshots', { method: 'POST', body: { volume_id: v.id, name } }); toast('Đang tạo snapshot…', 'ok'); setTimeout(load, 1000); }
    catch (e) { toast(e.message, 'error'); }
  }

  async function delSnap(s) {
    if (!window.confirm(`Xoá snapshot "${s.name}"?`)) return;
    try { await api(`/snapshots/${s.id}`, { method: 'DELETE' }); toast('Đã xoá snapshot', 'ok'); load(); }
    catch (e) { toast(e.message, 'error'); }
  }

  return (
    <>
      <PageHead title="Ổ đĩa (Volumes)" count={vols?.length} onRefresh={load}>
        <button className="btn primary" onClick={() => setCreating(true)}><Plus size={16} /> Tạo volume</button>
      </PageHead>

      {!vols ? <Empty>Đang tải…</Empty> : vols.length === 0 ? (
        <Empty>Chưa có volume nào.</Empty>
      ) : (
        <div className="card">
          <table className="tbl">
            <thead><tr><th>Tên</th><th>Trạng thái</th><th>Dung lượng</th><th>Loại</th><th>Đang gắn vào</th><th>Tạo lúc</th><th /></tr></thead>
            <tbody>
              {vols.map((v) => (
                <tr key={v.id}>
                  <td><b>{v.name || <span className="mono dim">{v.id.slice(0, 8)}</span>}</b></td>
                  <td><StatusBadge status={v.status} /></td>
                  <td className="mono">{v.size} GB</td>
                  <td className="dim">{v.volume_type || '—'}</td>
                  <td>{v.attachments?.length ? v.attachments.map((a) => <span key={a.server_id} className="chip">{serverName(a.server_id)} <em className="mono dim">{a.device}</em></span>) : <span className="dim">—</span>}</td>
                  <td className="dim">{fmtDate(v.created_at)}</td>
                  <td>
                    <ActionsMenu items={[
                      v.status === 'available' && { label: 'Gắn vào máy ảo', onClick: () => setAttachFor(v) },
                      v.status === 'in-use' && { label: 'Tháo khỏi máy ảo', onClick: () => detach(v) },
                      { label: 'Mở rộng dung lượng', onClick: () => extend(v) },
                      { label: 'Tạo snapshot', onClick: () => snapshot(v) },
                      'divider',
                      { label: 'Xoá volume', danger: true, disabled: v.status === 'in-use', onClick: () => del(v) },
                    ]} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <div className="card-head"><h4>Snapshots</h4></div>
        {snaps.length === 0 ? <Empty>Chưa có snapshot.</Empty> : (
          <table className="tbl">
            <thead><tr><th>Tên</th><th>Trạng thái</th><th>Dung lượng</th><th>Volume gốc</th><th>Tạo lúc</th><th /></tr></thead>
            <tbody>
              {snaps.map((s) => (
                <tr key={s.id}>
                  <td><b>{s.name}</b></td>
                  <td><StatusBadge status={s.status} /></td>
                  <td className="mono">{s.size} GB</td>
                  <td className="dim">{vols?.find((v) => v.id === s.volume_id)?.name || s.volume_id?.slice(0, 8)}</td>
                  <td className="dim">{fmtDate(s.created_at)}</td>
                  <td><button className="btn sm danger-ghost" onClick={() => delSnap(s)}>Xoá</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {creating && <CreateVolume onClose={() => setCreating(false)} onDone={() => { setCreating(false); setTimeout(load, 800); }} />}
      {attachFor && <AttachModal volume={attachFor} servers={servers} onClose={() => setAttachFor(null)} onDone={() => { setAttachFor(null); setTimeout(load, 1000); }} />}
    </>
  );
}

function CreateVolume({ onClose, onDone }) {
  const [f, setF] = useState({ name: '', size: 20, volume_type: '' });
  const [types, setTypes] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => { api('/volume-types').then((d) => setTypes(d.volume_types)).catch(() => {}); }, []);

  async function submit() {
    setBusy(true);
    try {
      await api('/volumes', { method: 'POST', body: { name: f.name, size: Number(f.size), volume_type: f.volume_type || undefined } });
      toast('Đang tạo volume…', 'ok');
      onDone();
    } catch (e) { toast(e.message, 'error'); setBusy(false); }
  }

  return (
    <Modal title="Tạo volume mới" onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Huỷ</button>
        <button className="btn primary" onClick={submit} disabled={busy}>{busy ? 'Đang tạo…' : 'Tạo volume'}</button></>}>
      <Field label="Tên volume"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="vd: data-app-01" autoFocus /></Field>
      <Field label="Dung lượng (GB)"><input type="number" min="1" value={f.size} onChange={(e) => setF({ ...f, size: e.target.value })} /></Field>
      <Field label="Loại volume">
        <select value={f.volume_type} onChange={(e) => setF({ ...f, volume_type: e.target.value })}>
          <option value="">— Mặc định —</option>
          {types.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
        </select>
      </Field>
    </Modal>
  );
}

function AttachModal({ volume, servers, onClose, onDone }) {
  const [sid, setSid] = useState(servers[0]?.id || '');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!sid) return;
    setBusy(true);
    try {
      await api(`/volumes/${volume.id}/attach`, { method: 'POST', body: { server_id: sid } });
      toast('Đang gắn volume…', 'ok');
      onDone();
    } catch (e) { toast(e.message, 'error'); setBusy(false); }
  }

  return (
    <Modal title={`Gắn volume "${volume.name || volume.id.slice(0, 8)}"`} onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Huỷ</button>
        <button className="btn primary" onClick={submit} disabled={busy || !sid}>Gắn volume</button></>}>
      <Field label="Chọn máy ảo">
        <select value={sid} onChange={(e) => setSid(e.target.value)}>
          {servers.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.status})</option>)}
        </select>
      </Field>
      <p className="dim">Thiết bị sẽ xuất hiện trong máy ảo dạng /dev/vdX — format và mount trong OS.</p>
    </Modal>
  );
}
