import React, { useEffect, useRef, useState } from 'react';
import { Plus, ArrowLeft, Download, Link2 } from 'lucide-react';
import { api, fmtBytes, fmtDate } from '../api.js';
import { Modal, Field, ActionsMenu, toast, Empty, PageHead } from '../components/ui.jsx';
import { useI18n } from '../i18n/react.jsx';

export default function ObjectStorage() {
  const { t } = useI18n();
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
    if (!window.confirm(t('objectStorage.deleteContainerConfirm', { name: c.name }))) return;
    try { await api(`/object/containers/${encodeURIComponent(c.name)}`, { method: 'DELETE' }); toast(t('objectStorage.containerDeleted'), 'ok'); load(); }
    catch (e) { toast(e.message, 'error'); }
  }

  if (available === null) return <Empty>{t('objectStorage.checking')}</Empty>;
  if (available === false) return (
    <>
      <PageHead title="Object Storage" />
      <Empty>
        {t('objectStorage.unavailable')} <b>object-store</b> (Swift/Ceph RGW).<br />
        {t('objectStorage.checkController')} <span className="mono">openstack service list | grep object-store</span>
      </Empty>
    </>
  );
  if (open) return <Browser container={open} onBack={() => { setOpen(null); load(); }} />;

  return (
    <>
      <PageHead title="Object Storage" count={containers?.length} onRefresh={load}>
        <button className="btn primary" onClick={() => setCreating(true)}><Plus size={16} /> {t('objectStorage.createContainer')}</button>
      </PageHead>
      <p className="dim page-desc">{t('objectStorage.description')}</p>

      {!containers ? <Empty>{t('common.loading')}</Empty> : containers.length === 0 ? (
        <Empty>{t('objectStorage.empty')}</Empty>
      ) : (
        <div className="card">
          <table className="tbl">
            <thead><tr><th>Container</th><th>{t('objectStorage.objectCount')}</th><th>{t('volumes.capacity')}</th><th /></tr></thead>
            <tbody>
              {containers.map((c) => (
                <tr key={c.name}>
                  <td><button className="link-btn" onClick={() => setOpen(c)}>{c.name}</button></td>
                  <td className="mono">{c.count}</td>
                  <td className="mono">{fmtBytes(c.bytes)}</td>
                  <td><ActionsMenu items={[
                    { label: t('objectStorage.open'), onClick: () => setOpen(c) },
                    'divider',
                    { label: t('objectStorage.deleteContainer'), danger: true, onClick: () => del(c) },
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
  const { t } = useI18n();
  const [f, setF] = useState({ name: '', public: false });
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!f.name.trim()) return toast(t('objectStorage.nameRequired'), 'error');
    setBusy(true);
    try { await api('/object/containers', { method: 'POST', body: f }); toast(t('objectStorage.containerCreated'), 'ok'); onDone(); }
    catch (e) { toast(e.message, 'error'); setBusy(false); }
  }
  return (
    <Modal title={t('objectStorage.createContainer')} onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn primary" onClick={submit} disabled={busy}>{t('common.create')}</button></>}>
      <Field label={t('objectStorage.containerName')}><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. backups" autoFocus /></Field>
      <label className="check-item">
        <input type="checkbox" checked={f.public} onChange={(e) => setF({ ...f, public: e.target.checked })} />
        {t('objectStorage.publicRead')}
      </label>
      <p className="warn-text">{f.public ? t('objectStorage.publicWarning') : ''}</p>
    </Modal>
  );
}

function Browser({ container, onBack }) {
  const { t } = useI18n();
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
      if (xhr.status >= 200 && xhr.status < 300) { toast(t('objectStorage.uploaded', { name: file.name }), 'ok'); load(); }
      else toast(t('images.uploadHttpError', { status: xhr.status }), 'error');
    };
    xhr.onerror = () => { setProgress(null); toast(t('objectStorage.uploadFailed'), 'error'); };
    xhr.send(file);
    if (fileRef.current) fileRef.current.value = '';
  }

  async function del(o) {
    if (!window.confirm(t('objectStorage.deleteObjectConfirm', { name: o.name }))) return;
    try {
      await api(`/object/containers/${encodeURIComponent(container.name)}/objects/${o.name.split('/').map(encodeURIComponent).join('/')}`, { method: 'DELETE' });
      toast(t('objectStorage.deleted'), 'ok'); load();
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
        <button className="btn ghost" onClick={onBack}><ArrowLeft size={15} /> {t('objectStorage.containerList')}</button>
        <input type="file" ref={fileRef} onChange={upload} style={{ display: 'none' }} />
        <button className="btn primary" onClick={() => fileRef.current?.click()} disabled={progress !== null}>
          {progress !== null ? t('objectStorage.uploading', { progress }) : t('objectStorage.uploadFile')}
        </button>
      </PageHead>
      {progress !== null && <div className="progress-track"><div className="progress-fill" style={{ width: progress + '%' }} /></div>}

      {!objects ? <Empty>{t('common.loading')}</Empty> : objects.length === 0 ? (
        <Empty>{t('objectStorage.noObjects')}</Empty>
      ) : (
        <div className="card">
          <table className="tbl">
            <thead><tr><th>{t('objectStorage.fileName')}</th><th>{t('objectStorage.size')}</th><th>{t('networks.type')}</th><th>{t('objectStorage.modified')}</th><th /></tr></thead>
            <tbody>
              {objects.map((o) => (
                <tr key={o.name}>
                  <td><b>{o.name}</b></td>
                  <td className="mono">{fmtBytes(o.bytes)}</td>
                  <td className="dim mono">{o.content_type}</td>
                  <td className="dim">{fmtDate(o.last_modified)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <a className="btn sm" href={`/api/object/containers/${encodeURIComponent(container.name)}/objects/${o.name.split('/').map(encodeURIComponent).join('/')}`}><Download size={14} /> {t('objectStorage.download')}</a>{' '}
                    <button className="btn sm ghost" onClick={() => tempUrl(o)}><Link2 size={14} /> {t('objectStorage.shareLink')}</button>{' '}
                    <button className="btn sm danger-ghost" onClick={() => del(o)}>{t('common.delete')}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {share && (
        <Modal title={t('objectStorage.shareTitle', { name: share.name })} onClose={() => setShare(null)}
          footer={<button className="btn primary" onClick={() => { navigator.clipboard?.writeText(share.url); toast(t('objectStorage.copied'), 'ok'); }}>{t('objectStorage.copyLink')}</button>}>
          <p>{t('objectStorage.shareDescription', { hours: share.hours })}</p>
          <p className="mono wrap">{share.url}</p>
        </Modal>
      )}
    </>
  );
}
