import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useI18n } from '../i18n/react.jsx';
import LanguageSwitcher from '../components/LanguageSwitcher.jsx';

export default function SsoOnboarding() {
  const { t } = useI18n();
  const nav = useNavigate();
  const [session, setSession] = useState(null);
  const [mode, setMode] = useState(null);
  const [form, setForm] = useState({ username: '', password: '', domain: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let active = true;
    api('/auth/session').then((value) => {
      if (!active) return;
      if (value.auth_mode !== 'sso') nav('/', { replace: true });
      else setSession(value);
    }).catch(() => { if (active) nav('/login', { replace: true }); });
    return () => { active = false; };
  }, [nav]);

  async function logout() {
    await api('/auth/sso/logout', { method: 'POST' }).catch(() => {});
    nav('/login', { replace: true });
  }

  async function link(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    const credentials = form;
    setForm({ username: '', password: '', domain: '' });
    try {
      const value = await api('/auth/sso/link-existing', { method: 'POST', body: credentials });
      setSession(value);
      setNotice(t('sso.linkSuccess'));
      setMode(null);
    } catch (ex) { setError(ex.message); }
    finally { setBusy(false); }
  }

  async function createAccount() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const value = await api('/auth/sso/create-cloud-account', { method: 'POST' });
      setSession(value);
      setNotice(t('sso.createSuccess'));
      setMode(null);
    } catch (ex) { setError(ex.message); }
    finally { setBusy(false); }
  }

  if (!session) return <div className="boot">{t('common.loading')}</div>;
  const profile = session.profile || {};
  const display = profile.displayName || profile.username || (profile.emailVerified ? profile.email : null) || t('sso.account');
  const state = session.auth_state;
  return <main className="sso-onboarding-page">
    <div className="sso-onboarding-top"><LanguageSwitcher /><button className="btn ghost" onClick={logout}>{t('sso.signOut')}</button></div>
    <section className="sso-onboarding-card">
      <img className="sso-onboarding-logo" src="/asset/logo.png" alt="MobiFone Solutions Cloud" />
      <h1>{state === 'SSO_VERIFIED_UNBOUND' ? t('sso.unboundTitle')
        : state === 'SSO_VERIFIED_BOUND' ? t('sso.readyTitle')
          : state === 'SSO_BOUND_USER_DISABLED' ? t('sso.disabledTitle') : t('sso.missingTitle')}</h1>
      <p className="sso-onboarding-profile">{display}</p>
      {profile.email && <p className="sso-onboarding-muted">{profile.email}{!profile.emailVerified && ` · ${t('sso.emailUnverified')}`}</p>}
      {notice && <div className="login-success" role="status">{notice}</div>}
      {error && <div className="login-err" role="alert">{error}</div>}
      {state === 'SSO_VERIFIED_UNBOUND' && <>
        <p className="sso-onboarding-muted">{t('sso.unboundDescription')}</p>
        {!mode && <div className="sso-onboarding-actions">
          <button className="btn primary" onClick={() => setMode('link')}>{t('sso.linkExisting')}</button>
          {session.provisioningEnabled && <button className="btn" onClick={() => setMode('create')}>{t('sso.createAccount')}</button>}
        </div>}
        {mode === 'link' && <form onSubmit={link} className="sso-onboarding-form">
          <label className="field"><span className="field-label">{t('sso.cloudUsername')}</span>
            <input required autoComplete="username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></label>
          <label className="field"><span className="field-label">{t('sso.currentPassword')}</span>
            <input required type="password" autoComplete="current-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
          <label className="field"><span className="field-label">{t('sso.domain')}</span>
            <input value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} /></label>
          <p className="sso-onboarding-muted">{t('sso.passwordOnce')}</p>
          <div className="sso-onboarding-actions"><button type="button" className="btn" disabled={busy} onClick={() => { setForm({ username: '', password: '', domain: '' }); setMode(null); }}>{t('common.cancel')}</button>
            <button className="btn primary" disabled={busy}>{busy ? t('common.loading') : t('sso.verifyLink')}</button></div>
        </form>}
        {mode === 'create' && <div className="sso-onboarding-form">
          <p>{t('sso.proposedUsername')}: <strong>{profile.username || '—'}</strong></p>
          <p className="sso-onboarding-muted">{t('sso.createExplanation')}</p>
          <div className="sso-onboarding-actions"><button className="btn" disabled={busy} onClick={() => setMode(null)}>{t('common.cancel')}</button>
            <button className="btn primary" disabled={busy} onClick={createAccount}>{busy ? t('common.loading') : t('sso.createAccount')}</button></div>
        </div>}
      </>}
      {state === 'SSO_VERIFIED_BOUND' && <>
        <p>{t('sso.cloudAccount')}: <strong>{session.cloudUser?.name || '—'}</strong></p>
        <p className="sso-onboarding-muted">{t('sso.phaseTwoNotice')}</p>
        <button className="btn" onClick={() => nav('/login')}>{t('sso.localLogin')}</button>
      </>}
      {state === 'SSO_BOUND_USER_MISSING' && <p className="sso-onboarding-muted">{t('sso.missingDescription')}</p>}
      {state === 'SSO_BOUND_USER_DISABLED' && <p className="sso-onboarding-muted">{t('sso.disabledDescription')}</p>}
    </section>
  </main>;
}
