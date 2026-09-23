import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Server, HardDrive, Network, Shield, Boxes, BarChart3 } from 'lucide-react';
import { api } from '../api.js';
import { useI18n } from '../i18n/react.jsx';
import LanguageSwitcher from '../components/LanguageSwitcher.jsx';
import { resources } from '../i18n/index.js';

const FEATURES = [
  [Server, 'featureCompute'],
  [HardDrive, 'featureStorage'],
  [Network, 'featureNetwork'],
  [Boxes, 'featureKubernetes'],
  [BarChart3, 'featureBilling'],
  [Shield, 'featureSecurity'],
];
const configFields = (message) => message?.match(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g)?.join(', ') || '';

export default function Login() {
  const { t, locale } = useI18n();
  const [cfg, setCfg] = useState({ cloudName: 'MBFS Cloud', defaultDomain: 'Default', mock: false, sso: false, websso: false, allowLocal: true });
  const [form, setForm] = useState({ username: '', password: '', domain: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();

  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('sso_error');
    if (q) setErr({ message: q, code: q, fromQuery: true });
    api('/auth/config').then((c) => { setCfg(c); setForm((f) => ({ ...f, domain: c.defaultDomain })); }).catch(() => {});
    api('/auth/session').then(() => nav('/', { replace: true })).catch(() => {});
  }, [nav]);

  async function submit(e) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      await api('/auth/login', { method: 'POST', body: form });
      nav('/', { replace: true });
    } catch (ex) {
      setErr(ex);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      {/* Nền động: aurora + lưới phối cảnh + hạt bay */}
      <div className="bg-layer" aria-hidden="true">
        <div className="aurora a1" />
        <div className="aurora a2" />
        <div className="aurora a3" />
        <div className="grid-floor" />
        <div className="dots" />
        <div className="particles">
          {Array.from({ length: 14 }).map((_, i) => <i key={i} style={{ '--i': i }} />)}
        </div>
      </div>

      <div className="login-shell">
        <section className="hero">
          <div className="hero-brand">
            <img className="hero-logo" src="/asset/logo.png" alt="MobiFone Solutions Cloud" />
          </div>
          <p className="hero-sub">{t('auth.hero')}</p>

          <IsoStack />

          <ul className="hero-feats">
            {FEATURES.map(([Icon, key]) => (
              <li key={key}>
                <span className="hf-icon"><Icon size={16} /></span>
                <span className="hf-text"><b>{t(`auth.${key}Title`)}</b><em>{t(`auth.${key}Description`)}</em></span>
              </li>
            ))}
          </ul>
        </section>

        <section className="login-col">
          <div className="login-language"><LanguageSwitcher /></div>
          <form className="login-card" onSubmit={submit}>
            <div className="login-brand">
              <img className="login-brand-mark" src="/asset/favicon.png" alt="" aria-hidden="true" />
              <div>
                <h2>{t('auth.title')}</h2>
                <p>{t('auth.subtitle')}</p>
              </div>
            </div>

            {cfg.mock && <div className="login-note">{t('auth.demoHint')}</div>}
            {err && <div className="login-err">{err.code && resources.vi[`errors.${err.code}`]
              ? t(`errors.${err.code}`)
              : locale === 'en' && (err.fromQuery || /[À-ỹ]/u.test(err.message || '')) ? t('auth.signInFailed') : err.message}</div>}
            {cfg.ssoError && <div className="login-err">{t('auth.ssoConfigError', { message: locale === 'vi' ? cfg.ssoError : configFields(cfg.ssoError) })}</div>}
            {cfg.webssoError && <div className="login-err">{t('auth.webssoConfigError', { message: locale === 'vi' ? cfg.webssoError : configFields(cfg.webssoError) })}</div>}

            {cfg.websso && (
              <>
                <a className="btn primary block sso-btn" href="/api/auth/websso/login">{locale === 'en' && /[À-ỹ]/u.test(cfg.webssoLabel || '') ? t('auth.ssoLogin') : cfg.webssoLabel || t('auth.ssoLogin')}</a>
                {cfg.allowLocal && <div className="login-or"><span>{t('auth.localOption')}</span></div>}
              </>
            )}

            {cfg.sso && !cfg.websso && (
              <>
                <a className="btn primary block sso-btn" href="/api/auth/sso/login">{locale === 'en' && /[À-ỹ]/u.test(cfg.ssoLabel || '') ? t('auth.ssoLogin') : cfg.ssoLabel || t('auth.ssoLogin')}</a>
                {cfg.allowLocal && <div className="login-or"><span>{t('auth.localOption')}</span></div>}
              </>
            )}

            {((!cfg.sso && !cfg.websso) || cfg.allowLocal) && <>
              <label className="field">
                <span className="field-label">{t('auth.username')}</span>
                <input autoFocus autoComplete="username" value={form.username}
                  onChange={(e) => setForm({ ...form, username: e.target.value })} />
              </label>
              <label className="field">
                <span className="field-label">{t('auth.password')}</span>
                <input type="password" autoComplete="current-password" value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })} />
              </label>
              <label className="field">
                <span className="field-label">Domain</span>
                <input value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} />
                <span className="field-hint">{t('auth.domainHint')}</span>
              </label>
              <button className="btn primary block" disabled={busy}>{busy ? t('auth.signingIn') : t('auth.title')}</button>
            </>}

            <p className="login-foot">{(cfg.sso || cfg.websso) && !cfg.allowLocal ? t('auth.ssoOnly') : t('auth.localHint')}</p>
          </form>
          <p className="login-copy">© {new Date().getFullYear()} MobiFone Solutions · Private Cloud Platform</p>
        </section>
      </div>
    </div>
  );
}

/* Minh hoạ isometric 3 tầng: Compute · Storage · Network — SVG thuần, tự nổi nhẹ */
function IsoStack() {
  const Layer = ({ y, label, cls }) => (
    <g className={`iso-layer ${cls}`} transform={`translate(0 ${y})`}>
      <path d="M130 20 L240 78 L130 136 L20 78 Z" className="iso-top" />
      <path d="M20 78 L130 136 L130 158 L20 100 Z" className="iso-left" />
      <path d="M240 78 L130 136 L130 158 L240 100 Z" className="iso-right" />
      <text x="130" y="84" textAnchor="middle" className="iso-text">{label}</text>
    </g>
  );
  return (
    <div className="iso-wrap" aria-hidden="true">
      <svg viewBox="0 0 260 300" className="iso-svg">
        <Layer y={118} label="NETWORK" cls="l3" />
        <Layer y={60} label="STORAGE" cls="l2" />
        <Layer y={2} label="COMPUTE" cls="l1" />
      </svg>
    </div>
  );
}
