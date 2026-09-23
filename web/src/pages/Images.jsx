import React, { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { api, apiErrorMessage, fmtDate, fmtBytes } from '../api.js';
import { Modal, Field, StatusBadge, toast, Empty, PageHead } from '../components/ui.jsx';
import { useI18n } from '../i18n/react.jsx';

export default function Images() {
  const { t } = useI18n();
  const [images, setImages] = useState(null);
  const [uploading, setUploading] = useState(false);

  async function load() {
    try { setImages((await api('/images')).images); }
    catch (e) { toast(e.message, 'error'); }
  }
  useEffect(() => { load(); }, []);

  async function del(img) {
    if (!window.confirm(t('images.deleteConfirm', { name: img.name }))) return;
    try { await api(`/images/${img.id}`, { method: 'DELETE' }); toast(t('images.deleted'), 'ok'); load(); }
    catch (e) { toast(e.message, 'error'); }
  }

  const visLabel = { public: 'Public', private: 'Private', shared: 'Shared', community: 'Community' };

  return (
    <>
      <PageHead title={t('navigation.images')} count={images?.length} onRefresh={load}>
        <button className="btn primary" onClick={() => setUploading(true)}><Plus size={16} /> {t('images.upload')}</button>
      </PageHead>
      <p className="dim page-desc">{t('images.description')}</p>

      {!images ? <Empty>{t('common.loading')}</Empty> : images.length === 0 ? <Empty>{t('images.empty')}</Empty> : (
        <div className="card">
          <table className="tbl">
            <thead><tr><th>{t('common.name')}</th><th>{t('common.status')}</th><th>{t('images.visibility')}</th><th>{t('images.format')}</th><th>{t('images.size')}</th><th>{t('common.createdAt')}</th><th /></tr></thead>
            <tbody>
              {images.map((img) => (
                <tr key={img.id}>
                  <td><b>{img.name || <span className="mono dim">{img.id.slice(0, 8)}</span>}</b></td>
                  <td><StatusBadge status={img.status} /></td>
                  <td className="dim">{visLabel[img.visibility] || img.visibility}</td>
                  <td className="mono dim">{img.disk_format || '—'}</td>
                  <td className="mono">{fmtBytes(img.size)}</td>
                  <td className="dim">{fmtDate(img.created_at)}</td>
                  <td>{img.visibility !== 'public' && <button className="btn sm danger-ghost" onClick={() => del(img)}>{t('common.delete')}</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {uploading && <UploadModal onClose={() => setUploading(false)} onDone={() => { setUploading(false); load(); }} />}
    </>
  );
}

function UploadModal({ onClose, onDone }) {
  const { t } = useI18n();
  const [f, setF] = useState({ name: '', disk_format: 'qcow2', min_disk: '', min_ram: '' });
  const [file, setFile] = useState(null);
  const [progress, setProgress] = useState(null); // null | 0..100
  const xhrRef = useRef(null);

  function pickFile(e) {
    const fl = e.target.files?.[0];
    if (!fl) return;
    setFile(fl);
    if (!f.name) {
      const base = fl.name.replace(/\.(qcow2|img|raw|iso|vmdk|vdi)$/i, '');
      const ext = (fl.name.match(/\.(qcow2|raw|iso|vmdk|vdi)$/i) || [])[1];
      setF((x) => ({ ...x, name: base, disk_format: ext ? ext.toLowerCase() : x.disk_format }));
    }
  }

  async function submit() {
    if (!f.name.trim()) return toast(t('images.nameRequired'), 'error');
    if (!file) return toast(t('images.fileRequired'), 'error');
    let imgId = null;
    try {
      // Bước 1: tạo metadata
      const meta = await api('/images', {
        method: 'POST',
        body: { name: f.name.trim(), disk_format: f.disk_format, min_disk: f.min_disk || undefined, min_ram: f.min_ram || undefined },
      });
      imgId = meta.image?.id;
      // Bước 2: upload nhị phân bằng XHR để có progress
      setProgress(0);
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhrRef.current = xhr;
        xhr.open('PUT', `/api/images/${imgId}/file`);
        xhr.setRequestHeader('X-CMP-Request', '1');
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.upload.onprogress = (ev) => {
          if (ev.lengthComputable) setProgress(Math.round((ev.loaded / ev.total) * 100));
        };
        xhr.onload = () => (xhr.status >= 200 && xhr.status < 300)
          ? resolve()
          : reject(new Error(safeErr(xhr) || t('images.uploadHttpError', { status: xhr.status })));
        xhr.onerror = () => reject(new Error(t('images.uploadNetworkError')));
        xhr.onabort = () => reject(new Error(t('images.uploadCancelled')));
        xhr.send(file);
      });
      toast(t('images.uploaded', { name: f.name }), 'ok');
      onDone();
    } catch (e) {
      toast(e.message, 'error');
      setProgress(null);
      // dọn metadata mồ côi nếu upload fail
      if (imgId) api(`/images/${imgId}`, { method: 'DELETE' }).catch(() => {});
    }
  }

  function safeErr(xhr) {
    try { return apiErrorMessage(JSON.parse(xhr.responseText), xhr.status); } catch { return null; }
  }

  function close() {
    if (progress !== null && progress < 100) {
      if (!window.confirm(t('images.cancelUploadConfirm'))) return;
      xhrRef.current?.abort();
    }
    onClose();
  }

  const busy = progress !== null;
  return (
    <Modal title={t('images.upload')} onClose={close}
      footer={<>
        <button className="btn ghost" onClick={close}>{t('common.close')}</button>
        <button className="btn primary" onClick={submit} disabled={busy}>{busy ? t('images.uploading', { progress }) : t('images.startUpload')}</button>
      </>}>
      <Field label={t('images.file')} hint={t('images.fileHint')}>
        <input type="file" onChange={pickFile} disabled={busy} />
      </Field>
      {file && <p className="dim">{t('images.selected')}: <b>{file.name}</b> ({fmtBytes(file.size)})</p>}
      <Field label={t('images.imageName')}><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} disabled={busy} /></Field>
      <Field label={t('images.diskFormat')}>
        <select value={f.disk_format} onChange={(e) => setF({ ...f, disk_format: e.target.value })} disabled={busy}>
          {['qcow2', 'raw', 'iso', 'vmdk', 'vdi'].map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
      </Field>
      <div className="row-inline">
        <Field label={t('images.minDisk')}><input type="number" min="0" value={f.min_disk} onChange={(e) => setF({ ...f, min_disk: e.target.value })} disabled={busy} /></Field>
        <Field label={t('images.minRam')}><input type="number" min="0" value={f.min_ram} onChange={(e) => setF({ ...f, min_ram: e.target.value })} disabled={busy} /></Field>
      </div>
      {busy && <div className="progress-track"><div className="progress-fill" style={{ width: progress + '%' }} /></div>}
    </Modal>
  );
}
