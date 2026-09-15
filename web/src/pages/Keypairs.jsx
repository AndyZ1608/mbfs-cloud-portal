import React, { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { api } from '../api.js';
import { Modal, Field, toast, Empty, PageHead } from '../components/ui.jsx';

export default function Keypairs() {
  const [keys, setKeys] = useState(null);
  const [creating, setCreating] = useState(false);
  const [privateKey, setPrivateKey] = useState(null); // {name, key}

  async function load() {
    try { setKeys((await api('/keypairs')).keypairs); }
    catch (e) { toast(e.message, 'error'); }
  }
  useEffect(() => { load(); }, []);

  async function del(k) {
    if (!window.confirm(`Xoá SSH key "${k.name}"? Các máy đang dùng key này không bị ảnh hưởng.`)) return;
    try { await api(`/keypairs/${encodeURIComponent(k.name)}`, { method: 'DELETE' }); toast('Đã xoá key', 'ok'); load(); }
    catch (e) { toast(e.message, 'error'); }
  }

  function download() {
    const blob = new Blob([privateKey.key], { type: 'application/x-pem-file' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${privateKey.name}.pem`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <>
      <PageHead title="SSH Keys" count={keys?.length} onRefresh={load}>
        <button className="btn primary" onClick={() => setCreating(true)}><Plus size={16} /> Thêm key</button>
      </PageHead>

      {!keys ? <Empty>Đang tải…</Empty> : keys.length === 0 ? (
        <Empty>Chưa có SSH key. Thêm key để đăng nhập máy ảo Linux không cần mật khẩu.</Empty>
      ) : (
        <div className="card">
          <table className="tbl">
            <thead><tr><th>Tên</th><th>Fingerprint</th><th /></tr></thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.name}>
                  <td><b>{k.name}</b></td>
                  <td className="mono dim">{k.fingerprint}</td>
                  <td><button className="btn sm danger-ghost" onClick={() => del(k)}>Xoá</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && (
        <CreateKey onClose={() => setCreating(false)}
          onDone={(pk) => { setCreating(false); load(); if (pk) setPrivateKey(pk); }} />
      )}

      {privateKey && (
        <Modal title={`Private key — ${privateKey.name}`} onClose={() => setPrivateKey(null)}
          footer={<button className="btn primary" onClick={download}>Tải về {privateKey.name}.pem</button>}>
          <p className="warn-text">Private key chỉ hiển thị MỘT LẦN. Hãy tải về và cất giữ an toàn (chmod 600).</p>
          <textarea className="mono key-area" readOnly value={privateKey.key} rows={10} onFocus={(e) => e.target.select()} />
        </Modal>
      )}
    </>
  );
}

function CreateKey({ onClose, onDone }) {
  const [mode, setMode] = useState('generate');
  const [f, setF] = useState({ name: '', public_key: '' });
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!f.name.trim()) return toast('Nhập tên key', 'error');
    if (mode === 'import' && !f.public_key.trim()) return toast('Dán public key vào', 'error');
    setBusy(true);
    try {
      const d = await api('/keypairs', {
        method: 'POST',
        body: { name: f.name.trim(), public_key: mode === 'import' ? f.public_key.trim() : undefined },
      });
      toast(`Đã thêm key ${f.name}`, 'ok');
      onDone(d.keypair?.private_key ? { name: f.name.trim(), key: d.keypair.private_key } : null);
    } catch (e) { toast(e.message, 'error'); setBusy(false); }
  }

  return (
    <Modal title="Thêm SSH key" onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Huỷ</button>
        <button className="btn primary" onClick={submit} disabled={busy}>{mode === 'generate' ? 'Tạo key mới' : 'Import key'}</button></>}>
      <div className="tab-row">
        <button className={`tab ${mode === 'generate' ? 'active' : ''}`} onClick={() => setMode('generate')}>Tạo mới</button>
        <button className={`tab ${mode === 'import' ? 'active' : ''}`} onClick={() => setMode('import')}>Import public key</button>
      </div>
      <Field label="Tên key"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="vd: hieptd-laptop" autoFocus /></Field>
      {mode === 'import' && (
        <Field label="Public key (nội dung ~/.ssh/id_ed25519.pub)">
          <textarea className="mono" rows={4} value={f.public_key} onChange={(e) => setF({ ...f, public_key: e.target.value })} placeholder="ssh-ed25519 AAAA… user@host" />
        </Field>
      )}
      {mode === 'generate' && <p className="dim">Hệ thống sẽ sinh cặp key — private key hiển thị một lần duy nhất sau khi tạo.</p>}
    </Modal>
  );
}
