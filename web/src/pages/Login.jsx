import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Server, HardDrive, Network, Shield, Boxes, BarChart3 } from 'lucide-react';
import { api } from '../api.js';

const FEATURES = [
  [Server, 'Máy ảo', 'Tạo, resize, console, snapshot'],
  [HardDrive, 'Ổ đĩa & Backup', 'Volume, snapshot, lịch tự động'],
  [Network, 'Mạng & Load Balancer', 'VPC, Floating IP, Octavia'],
  [Boxes, 'Kubernetes', 'Dựng cụm RKE2 một bước'],
  [BarChart3, 'Billing', 'Số liệu theo project từ Billing service'],
  [Shield, 'Bảo mật', 'Security group, SSH key, nhật ký'],
];

export default function Login() {
  const [cfg, setCfg] = useState({ cloudName: 'MBFS Cloud', defaultDomain: 'Default', mock: false, sso: false, websso: false, allowLocal: true });
  const [form, setForm] = useState({ username: '', password: '', domain: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();

  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('sso_error');
    if (q) setErr(q);
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
      setErr(ex.message);
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
          <p className="hero-sub">Cổng tự phục vụ hạ tầng OpenStack — khởi tạo máy chủ, mạng và lưu trữ trong vài phút, không phải chờ đội vận hành.</p>

          <IsoStack />

          <ul className="hero-feats">
            {FEATURES.map(([Icon, title, desc]) => (
              <li key={title}>
                <span className="hf-icon"><Icon size={16} /></span>
                <span className="hf-text"><b>{title}</b><em>{desc}</em></span>
              </li>
            ))}
          </ul>
        </section>

        <section className="login-col">
          <form className="login-card" onSubmit={submit}>
            <div className="login-brand">
              <img className="login-brand-mark" src="/asset/favicon.png" alt="" aria-hidden="true" />
              <div>
                <h2>Đăng nhập</h2>
                <p>Truy cập bảng điều khiển hạ tầng</p>
              </div>
            </div>

            {cfg.mock && <div className="login-note">Chế độ demo: nhập tài khoản/mật khẩu bất kỳ để vào.</div>}
            {err && <div className="login-err">{err}</div>}
            {cfg.ssoError && <div className="login-err">Cấu hình SSO chưa đủ: {cfg.ssoError}</div>}
            {cfg.webssoError && <div className="login-err">Cấu hình WebSSO chưa đủ: {cfg.webssoError}</div>}

            {cfg.websso && (
              <>
                <a className="btn primary block sso-btn" href="/api/auth/websso/login">{cfg.webssoLabel || 'Đăng nhập bằng SSO'}</a>
                {cfg.allowLocal && <div className="login-or"><span>hoặc dùng tài khoản OpenStack</span></div>}
              </>
            )}

            {cfg.sso && !cfg.websso && (
              <>
                <a className="btn primary block sso-btn" href="/api/auth/sso/login">{cfg.ssoLabel || 'Đăng nhập bằng SSO'}</a>
                {cfg.allowLocal && <div className="login-or"><span>hoặc dùng tài khoản OpenStack</span></div>}
              </>
            )}

            {((!cfg.sso && !cfg.websso) || cfg.allowLocal) && <>
              <label className="field">
                <span className="field-label">Tài khoản</span>
                <input autoFocus autoComplete="username" value={form.username}
                  onChange={(e) => setForm({ ...form, username: e.target.value })} />
              </label>
              <label className="field">
                <span className="field-label">Mật khẩu</span>
                <input type="password" autoComplete="current-password" value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })} />
              </label>
              <label className="field">
                <span className="field-label">Domain</span>
                <input value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} />
                <span className="field-hint">Domain Keystone — giữ nguyên nếu không chắc</span>
              </label>
              <button className="btn primary block" disabled={busy}>{busy ? 'Đang đăng nhập…' : 'Đăng nhập'}</button>
            </>}

            <p className="login-foot">{(cfg.sso || cfg.websso) && !cfg.allowLocal ? 'Hệ thống chỉ đăng nhập qua SSO.' : 'Dùng tài khoản OpenStack (Keystone) do quản trị viên cấp.'}</p>
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
