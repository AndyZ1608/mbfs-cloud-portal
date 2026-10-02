import React, { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { api, fmtDate, fmtBytes } from '../api.js';
import { Modal, Field, StatusBadge, toast, Empty, PageHead } from '../components/ui.jsx';
import { useI18n } from '../i18n/react.jsx';
import { imageUploadFormat, uploadImageFile } from '../imageUpload.js';
import { MAX_IMAGE_UPLOAD_BYTES } from '../../../shared/imageUploadPolicy.mjs';

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
  const [f, setF] = useState({ name: '', min_disk: '', min_ram: '' });
  const [file, setFile] = useState(null);
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState('idle');
  const xhrRef = useRef(null);
  const submitting = useRef(false);

  function pickFile(e) {
    const fl = e.target.files?.[0];
    if (!fl) return;
    if (!imageUploadFormat(fl.name)) {
      setFile(null);
      e.target.value = '';
      toast(t('images.unsupportedFormat'), 'error');
      return;
    }
    setFile(fl);
    if (fl.size >= MAX_IMAGE_UPLOAD_BYTES) toast(t('images.sizeTooLarge'), 'error');
    if (!f.name) {
      setF((x) => ({ ...x, name: fl.name.replace(/\.(qcow2|iso)$/i, '') }));
    }
  }

  async function submit() {
    if (submitting.current) return;
    if (!f.name.trim()) return toast(t('images.nameRequired'), 'error');
    if (!file) return toast(t('images.fileRequired'), 'error');
    if (!imageUploadFormat(file.name)) return toast(t('images.unsupportedFormat'), 'error');
    if (file.size >= MAX_IMAGE_UPLOAD_BYTES) return toast(t('images.sizeTooLarge'), 'error');
    submitting.current = true;
    setPhase('uploading');
    setProgress(0);
    try {
      const result = await uploadImageFile({ file, name: f.name.trim(), minDisk: f.min_disk, minRam: f.min_ram,
        onRequest: (xhr) => { xhrRef.current = xhr; },
        onProgress: (percent) => {
          setProgress(percent);
          if (percent === 100) setPhase('processing');
        },
      });
      toast(t(result.processing ? 'images.processing' : 'images.uploaded'), result.processing ? 'info' : 'ok');
      onDone();
    } catch (e) {
      toast(e.message, 'error');
      setPhase('idle');
    } finally {
      submitting.current = false;
      xhrRef.current = null;
    }
  }

  function close() {
    if (submitting.current) {
      if (!window.confirm(t('images.cancelUploadConfirm'))) return;
      xhrRef.current?.abort();
    }
    onClose();
  }

  const busy = phase !== 'idle';
  return (
    <Modal title={t('images.upload')} onClose={close}
      footer={<>
        <button className="btn ghost" onClick={close}>{t('common.close')}</button>
        <button className="btn primary" onClick={submit} disabled={busy}>{phase === 'uploading'
          ? t('images.uploading', { progress }) : phase === 'processing' ? t('images.sendingToOpenStack') : t('images.startUpload')}</button>
      </>}>
      <Field label={t('images.file')} hint={t('images.fileHint')}>
        <input type="file" accept=".qcow2,.iso" onChange={pickFile} disabled={busy} />
      </Field>
      {file && <p className="dim">{t('images.selected')}: <b>{file.name}</b> ({fmtBytes(file.size)})</p>}
      {file && file.size >= MAX_IMAGE_UPLOAD_BYTES && <p className="err-text">{t('images.sizeTooLarge')}</p>}
      <Field label={t('images.imageName')}><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} disabled={busy} /></Field>
      <div className="row-inline">
        <Field label={t('images.minDisk')}><input type="number" min="0" value={f.min_disk} onChange={(e) => setF({ ...f, min_disk: e.target.value })} disabled={busy} /></Field>
        <Field label={t('images.minRam')}><input type="number" min="0" value={f.min_ram} onChange={(e) => setF({ ...f, min_ram: e.target.value })} disabled={busy} /></Field>
      </div>
      {busy && <div className="progress-track"><div className="progress-fill" style={{ width: progress + '%' }} /></div>}
    </Modal>
  );
}
