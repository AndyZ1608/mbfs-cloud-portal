import React, { useRef, useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n/react.jsx';
import { Field, Modal } from './ui.jsx';
import { emptyAccountPasswordForm, submitAccountPassword, validateAccountPasswordForm } from '../accountPassword.js';

export default function AccountPasswordModal({ username, onClose, onSuccess }) {
  const { t } = useI18n();
  const [form, setForm] = useState(emptyAccountPasswordForm);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);

  function close() {
    if (submitting.current) return;
    setForm(emptyAccountPasswordForm());
    setError(null);
    onClose();
  }

  async function submit(event) {
    event.preventDefault();
    if (submitting.current) return;
    const validation = validateAccountPasswordForm(form);
    if (validation) { setError(validation); return; }
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      await submitAccountPassword(form, api);
      setForm(emptyAccountPasswordForm());
      onSuccess();
    } catch (failure) {
      setForm((previous) => ({ ...previous, currentPassword: '' }));
      setError(failure.status === 429 ? 'account.tooManyAttempts' :
        ({
          account_current_password_incorrect: 'account.currentPasswordIncorrect',
          account_password_rejected: 'account.passwordRejected',
          account_password_unsupported: 'account.passwordUnsupported',
          account_keystone_unavailable: 'account.keystoneUnavailable',
          account_password_same: 'account.passwordSame',
          account_password_required: 'account.passwordRequired',
        })[failure.code] || 'account.passwordChangeFailed');
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  const update = (key) => (event) => {
    setForm((previous) => ({ ...previous, [key]: event.target.value }));
    setError(null);
  };
  return <Modal title={t('account.changePassword')} onClose={close}>
    <form onSubmit={submit}>
      <p className="account-password-identity"><span>{t('account.title')}</span><strong>{username}</strong></p>
      <Field label={t('account.currentPassword')}><input type="password" autoComplete="current-password" value={form.currentPassword} onChange={update('currentPassword')} disabled={busy} /></Field>
      <Field label={t('account.newPassword')}><input type="password" autoComplete="new-password" value={form.newPassword} onChange={update('newPassword')} disabled={busy} /></Field>
      <Field label={t('account.confirmPassword')}><input type="password" autoComplete="new-password" value={form.confirmPassword} onChange={update('confirmPassword')} disabled={busy} /></Field>
      {error && <p className="account-password-error" role="alert">{t(error)}</p>}
      <div className="account-password-actions">
        <button type="button" className="btn ghost" onClick={close} disabled={busy}>{t('common.cancel')}</button>
        <button type="submit" className="btn primary" disabled={busy}>{busy ? t('account.changingPassword') : t('account.changePassword')}</button>
      </div>
    </form>
  </Modal>;
}
