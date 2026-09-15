import React, { useEffect, useRef, useState } from 'react';
import { Plus, ArrowLeft, Download, Link2 } from 'lucide-react';
import { api, fmtBytes, fmtDate } from '../api.js';
import { Modal, Field, ActionsMenu, toast, Empty, PageHead } from '../components/ui.jsx';

export default function ObjectStorage() {
  const [available, setAvailable] = useState(null);
  const [containers, setContainers] = useState(null);
  const [open, setOpen] = useState(null); // container đang mở
  const [creating, setCreating] = useState(false);

  async function load() {
    try { setContainers((await api('/object/containers')).containers); }
    catch (e) { toast(e.message, 'error'); }
  }
  useEffect(() => {
    api('/object/available').then((d) => { setAvailable(d.available); if (d.available) load(); }).catch(() => setAvailable(false));
  }, []);

  async function del(c) {
    if (!window.confirm(`Xoá container "${c.name}"? Phải xoá hết object bên trong trước.`)) return;
    try { await api(`/object/containers/${encodeURIComponent(c.name)}`, { method: 'DELETE' }); toast('Đã xoá container', 'ok'); load(); }
    catch (e) { toast(e.message, 'error'); }
  }

  if (available === null) return <Empty>Đang kiểm tra Object Storage…</Empty>;
  if (available === false) return (
    <>
      <PageHead title="Object Storage" />
      <Empty>
        Cụm chưa có dịch vụ <b>object-store</b> (Swift hoặc Ceph RGW).<br />
        Kiểm tra trên controller: <span className="mono">openstack service list | grep object-store</span>
      </Empty>
    </>
  );
  if (open) return <Browser container={open} onBack={() => { setOpen(null); load(); }} />;

  return (
    <>
      <PageHead title="Object Storage" count={containers?.length} onRefresh={load}>
        <button className="btn primary" onClick={() => setCreating(true)}><Plus size={16} /> Tạo container</button>
      </PageHead>
      <p className="dim page-desc">Lưu trữ tệp theo chuẩn Swift/S3 — phù hợp cho backup, log, file tĩnh. Có thể tạo link chia sẻ tạm thời cho từng file.</p>

      {!containers ? <Empty>Đang tải…</Empty> : containers.length === 0 ? (
        <Empty>Chưa có container nào.</Empty>
      ) : (
        <div className="card">
          <table className="tbl">
            <thead><tr><th>Container</th><th>Số object</th><th>Dung lượng</th><th /></tr></thead>
            <tbody>
              {containers.map((c) => (
                <tr key={c.name}>
                  <td><button className="link-btn" onClick={() => setOpen(c)}>{c.name}</button></td>
                  <td className="mono">{c.count}</td>
                  <td className="mono">{fmtBytes(c.bytes)}</td>
                  <td><ActionsMenu items={[
                    { label: 'Mở', onClick: () => setOpen(c) },
                    'divider',
                    { label: 'Xoá container', danger: true, onClick: () => del(c) },
                  ]} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && <CreateContainer onClose={() => setCreating(false)} onDone={() => { setCreating(false); load(); }} />}
    </>
  );
}

function CreateContainer({ onClose, onDone }) {
  const [f, setF] = useState({ name: '', public: false });
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!f.name.trim()) return toast('Nhập tên container', 'error');
    setBusy(true);
    try { await api('/object/containers', { method: 'POST', body: f }); toast('Đã tạo container', 'ok'); onDone(); }
    catch (e) { toast(e.message, 'error'); setBusy(false); }
  }
  return (
    <Modal title="Tạo container" onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Huỷ</button>
        <button className="btn primary" onClick={submit} disabled={busy}>Tạo</button></>}>
      <Field label="Tên container"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="vd: backups" autoFocus /></Field>
      <label className="check-item">
        <input type="checkbox" checked={f.public} onChange={(e) => setF({ ...f, public: e.target.checked })} />
        Cho phép đọc công khai (ai có link đều tải được)
      </label>
      <p className="warn-text">{f.public ? 'Cân nhắc: mọi người trên mạng có thể đọc toàn bộ file trong container này.' : ''}</p>
    </Modal>
  );
}

function Browser({ container, onBack }) {
  const [objects, setObjects] = useState(null);
  const [progress, setProgress] = useState(null);
  const [share, setShare] = useState(null);
  const fileRef = useRef(null);

  async function load() {
    try { setObjects((await api(`/object/containers/${encodeURIComponent(container.name)}/objects`)).objects); }
    catch (e) { toast(e.message, 'error'); }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line

  function upload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setProgress(0);
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/object/containers/${encodeURIComponent(container.name)}/objects/${file.name.split('/').map(encodeURIComponent).join('/')}`);
    xhr.setRequestHeader('X-CMP-Request', '1');
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (ev) => ev.lengthComputable && setProgress(Math.round((ev.loaded / ev.total) * 100));
    xhr.onload = () => {
      setProgress(null);
      if (xhr.status >= 200 && xhr.status < 300) { toast(`Đã tải lên ${file.name}`, 'ok'); load(); }
      else toast(`Upload lỗi HTTP ${xhr.status}`, 'error');
    };
    xhr.onerror = () => { setProgress(null); toast('Upload thất bại', 'error'); };
    xhr.send(file);
    if (fileRef.current) fileRef.current.value = '';
  }

  async function del(o) {
    if (!window.confirm(`Xoá "${o.name}"?`)) return;
    try {
      await api(`/object/containers/${encodeURIComponent(container.name)}/objects/${o.name.split('/').map(encodeURIComponent).join('/')}`, { method: 'DELETE' });
      toast('Đã xoá', 'ok'); load();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function tempUrl(o) {
    try {
      const d = await api('/object/temp-url', { method: 'POST', body: { container: container.name, object: o.name, seconds: 86400 } });
      setShare({ name: o.name, url: d.url, hours: Math.round(d.expires_in / 3600) });
    } catch (e) { toast(e.message, 'error'); }
  }

  return (
    <>
      <PageHead title={`Object Storage · ${container.name}`} count={objects?.length} onRefresh={load}>
        <button className="btn ghost" onClick={onBack}><ArrowLeft size={15} /> Danh sách container</button>
        <input type="file" ref={fileRef} onChange={upload} style={{ display: 'none' }} />
        <button className="btn primary" onClick={() => fileRef.current?.click()} disabled={progress !== null}>
          {progress !== null ? `Đang tải lên ${progress}%` : 'Tải file lên'}
        </button>
      </PageHead>
      {progress !== null && <div className="progress-track"><div className="progress-fill" style={{ width: progress + '%' }} /></div>}

      {!objects ? <Empty>Đang tải…</Empty> : objects.length === 0 ? (
        <Empty>Container trống. Bấm "Tải file lên" để bắt đầu.</Empty>
      ) : (
        <div className="card">
          <table className="tbl">
            <thead><tr><th>Tên file</th><th>Kích thước</th><th>Loại</th><th>Sửa lần cuối</th><th /></tr></thead>
            <tbody>
              {objects.map((o) => (
                <tr key={o.name}>
                  <td><b>{o.name}</b></td>
                  <td className="mono">{fmtBytes(o.bytes)}</td>
                  <td className="dim mono">{o.content_type}</td>
                  <td className="dim">{fmtDate(o.last_modified)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <a className="btn sm" href={`/api/object/containers/${encodeURIComponent(container.name)}/objects/${o.name.split('/').map(encodeURIComponent).join('/')}`}><Download size={14} /> Tải</a>{' '}
                    <button className="btn sm ghost" onClick={() => tempUrl(o)}><Link2 size={14} /> Link chia sẻ</button>{' '}
                    <button className="btn sm danger-ghost" onClick={() => del(o)}>Xoá</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {share && (
        <Modal title={`Link chia sẻ — ${share.name}`} onClose={() => setShare(null)}
          footer={<button className="btn primary" onClick={() => { navigator.clipboard?.writeText(share.url); toast('Đã copy link', 'ok'); }}>Copy link</button>}>
          <p>Link tải trực tiếp, hết hạn sau <b>{share.hours} giờ</b> — ai có link đều tải được, không cần đăng nhập.</p>
          <p className="mono wrap">{share.url}</p>
        </Modal>
      )}
    </>
  );
}
