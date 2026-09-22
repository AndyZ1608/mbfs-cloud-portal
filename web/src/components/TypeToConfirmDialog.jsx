import React, { useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Modal, Spinner } from './ui.jsx';
import { matchesExactConfirmation } from '../utils/confirmation.js';

export default function TypeToConfirmDialog({
  title,
  description,
  resourceName,
  resourceId,
  confirmLabel,
  loading = false,
  onConfirm,
  onCancel,
}) {
  const [confirmation, setConfirmation] = useState('');
  const inputRef = useRef(null);
  const formId = useId();
  const inputId = useId();
  const canConfirm = matchesExactConfirmation(confirmation, resourceName) && !loading;

  useEffect(() => {
    setConfirmation('');
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [resourceId, resourceName]);

  function cancel() {
    if (loading) return;
    setConfirmation('');
    onCancel();
  }

  function submit(event) {
    event.preventDefault();
    if (!canConfirm) return;
    onConfirm();
  }

  return (
    <Modal title={title} onClose={cancel} footer={<>
      <button className="btn ghost" type="button" onClick={cancel} disabled={loading}>Huỷ</button>
      <button className="btn danger" type="submit" form={formId} disabled={!canConfirm} aria-disabled={!canConfirm}>
        {loading && <Spinner size={15} />}{loading ? 'Đang xoá…' : confirmLabel}
      </button>
    </>}>
      <form id={formId} onSubmit={submit}>
        <div className="danger-confirm-warning" role="alert">
          <AlertTriangle aria-hidden="true" size={20} />
          <div><strong>Hành động không thể hoàn tác</strong><p>{description}</p></div>
        </div>
        <dl className="danger-confirm-resource">
          <div><dt>Tên</dt><dd>{resourceName}</dd></div>
          {resourceId && <div><dt>ID</dt><dd className="mono">{resourceId}</dd></div>}
        </dl>
        <label className="field" htmlFor={inputId}>
          <span className="field-label">Nhập chính xác <strong>{resourceName}</strong> để xác nhận</span>
          <input
            ref={inputRef}
            id={inputId}
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            disabled={loading}
            autoComplete="off"
            spellCheck="false"
            aria-describedby={`${inputId}-hint`}
          />
          <span className="field-hint" id={`${inputId}-hint`}>Phân biệt chữ hoa, chữ thường và khoảng trắng.</span>
        </label>
      </form>
    </Modal>
  );
}
