import React, { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { api } from '../api.js';
import { Modal, Field, toast, Empty, PageHead } from '../components/ui.jsx';
import { useI18n } from '../i18n/react.jsx';

export default function Keypairs() {
  const { t } = useI18n();
  const [keys, setKeys] = useState(null);
  const [creating, setCreating] = useState(false);
  const [privateKey, setPrivateKey] = useState(null); // {name, key}

  async function load() {
    try { setKeys((await api('/keypairs')).keypairs); }
    catch (e) { toast(e.message, 'error'); }
  }
  useEffect(() => { load(); }, []);

  async function del(k) {
    if (!window.confirm(t('keypairs.deleteConfirm', { name: k.name }))) return;
    try { await api(`/keypairs/${encodeURIComponent(k.name)}`, { method: 'DELETE' }); toast(t('keypairs.deleted'), 'ok'); load(); }
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
      <PageHead title={t('navigation.keypairs')} count={keys?.length} onRefresh={load}>
        <button className="btn primary" onClick={() => setCreating(true)}><Plus size={16} /> {t('keypairs.add')}</button>
      </PageHead>

      {!keys ? <Empty>{t('common.loading')}</Empty> : keys.length === 0 ? (
        <Empty>{t('keypairs.empty')}</Empty>
      ) : (
        <div className="card">
          <table className="tbl">
            <thead><tr><th>{t('common.name')}</th><th>Fingerprint</th><th /></tr></thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.name}>
                  <td><b>{k.name}</b></td>
                  <td className="mono dim">{k.fingerprint}</td>
                  <td><button className="btn sm danger-ghost" onClick={() => del(k)}>{t('common.delete')}</button></td>
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
          footer={<button className="btn primary" onClick={download}>{t('keypairs.download', { name: privateKey.name })}</button>}>
          <p className="warn-text">{t('keypairs.privateWarning')}</p>
          <textarea className="mono key-area" readOnly value={privateKey.key} rows={10} onFocus={(e) => e.target.select()} />
        </Modal>
      )}
    </>
  );
}

function CreateKey({ onClose, onDone }) {
  const { t } = useI18n();
  const [mode, setMode] = useState('generate');
  const [f, setF] = useState({ name: '', public_key: '' });
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!f.name.trim()) return toast(t('keypairs.nameRequired'), 'error');
    if (mode === 'import' && !f.public_key.trim()) return toast(t('keypairs.publicRequired'), 'error');
    setBusy(true);
    try {
      const d = await api('/keypairs', {
        method: 'POST',
        body: { name: f.name.trim(), public_key: mode === 'import' ? f.public_key.trim() : undefined },
      });
      toast(t('keypairs.added', { name: f.name }), 'ok');
      onDone(d.keypair?.private_key ? { name: f.name.trim(), key: d.keypair.private_key } : null);
    } catch (e) { toast(e.message, 'error'); setBusy(false); }
  }

  return (
    <Modal title={t('keypairs.add')} onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn primary" onClick={submit} disabled={busy}>{t(mode === 'generate' ? 'keypairs.generate' : 'keypairs.import')}</button></>}>
      <div className="tab-row">
        <button className={`tab ${mode === 'generate' ? 'active' : ''}`} onClick={() => setMode('generate')}>{t('keypairs.new')}</button>
        <button className={`tab ${mode === 'import' ? 'active' : ''}`} onClick={() => setMode('import')}>{t('keypairs.importPublic')}</button>
      </div>
      <Field label={t('keypairs.keyName')}><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. laptop-key" autoFocus /></Field>
      {mode === 'import' && (
        <Field label={t('keypairs.publicLabel')}>
          <textarea className="mono" rows={4} value={f.public_key} onChange={(e) => setF({ ...f, public_key: e.target.value })} placeholder="ssh-ed25519 AAAA… user@host" />
        </Field>
      )}
      {mode === 'generate' && <p className="dim">{t('keypairs.generateHint')}</p>}
    </Modal>
  );
}
