import React, { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { LayoutDashboard, Server, HardDrive, Network, Globe, Shield, Disc3, KeyRound, BarChart3, Scale, DatabaseBackup, History, Store, Boxes, Wrench, PiggyBank, CalendarClock, Archive, Bell, Moon, Sun, LogOut, Cloud } from 'lucide-react';
import { api, fmtDate } from '../api.js';
import { Toasts, toast } from './ui.jsx';

const NAV = [
  { to: '/', label: 'Tổng quan', icon: LayoutDashboard, end: true },
  { to: '/instances', label: 'Máy ảo', icon: Server },
  { to: '/marketplace', label: 'Ứng dụng mẫu', icon: Store },
  { to: '/kubernetes', label: 'Kubernetes', icon: Boxes },
  { to: '/volumes', label: 'Ổ đĩa', icon: HardDrive },
  { to: '/networks', label: 'Mạng & Router', icon: Network },
  { to: '/floating-ips', label: 'Floating IP', icon: Globe },
  { to: '/load-balancers', label: 'Load Balancer', icon: Scale },
  { to: '/security-groups', label: 'Security Group', icon: Shield },
  { to: '/object-storage', label: 'Object Storage', icon: Archive },
  { to: '/images', label: 'Images', icon: Disc3 },
  { to: '/keypairs', label: 'SSH Keys', icon: KeyRound },
  { to: '/backup', label: 'Backup tự động', icon: DatabaseBackup },
  { to: '/power', label: 'Lịch bật/tắt', icon: CalendarClock },
  { to: '/optimize', label: 'Tối ưu chi phí', icon: PiggyBank },
  { to: '/audit', label: 'Nhật ký hoạt động', icon: History },
  { to: '/usage', label: 'Chi phí & Sử dụng', icon: BarChart3 },
];

export default function Layout() {
  const [sess, setSess] = useState(null);
  const [cfg, setCfg] = useState({ cloudName: 'MBFS Cloud' });
  const nav = useNavigate();

  useEffect(() => {
    api('/auth/config').then(setCfg).catch(() => {});
    api('/auth/session')
      .then(setSess)
      .catch(() => nav('/login', { replace: true }));
  }, [nav]);

  async function switchProject(projectId) {
    try {
      const path = sess?.auth_mode === 'sso' ? '/auth/sso/switch-project' : '/auth/switch-project';
      await api(path, { method: 'POST', body: { projectId } });
      window.location.reload();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function logout() {
    if (sess?.auth_mode === 'sso') {
      const r = await api('/auth/sso/logout', { method: 'POST' }).catch(() => null);
      if (r?.redirect) { window.location.href = r.redirect; return; }
    } else {
      const r = await api('/auth/logout', { method: 'POST' }).catch(() => null);
      if (r?.redirect) { window.location.href = r.redirect; return; }
    }
    nav('/login', { replace: true });
  }

  if (!sess) return <div className="boot">Đang tải…</div>;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <Cloud size={22} />
          <span>{cfg.cloudName}</span>
        </div>
        <nav>
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
              <Icon size={17} />
              <span>{label}</span>
            </NavLink>
          ))}
          {sess?.roles?.includes('admin') && (
            <NavLink to="/admin" className={({ isActive }) => `nav-item nav-admin ${isActive ? 'active' : ''}`}>
              <Wrench size={17} />
              <span>Quản trị cụm</span>
            </NavLink>
          )}
        </nav>
        <div className="sidebar-foot">
          {cfg.mock && <div className="mock-flag">CHẾ ĐỘ DEMO</div>}
          <span className="ver">portal v2.4</span>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="topbar-left">
            <span className="tb-label">Project</span>
            <select className="project-select" value={sess.project.id} onChange={(e) => switchProject(e.target.value)}>
              {sess.projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <div className="topbar-right">
            <ThemeToggle />
            <NotifBell />
            <span className="user-chip">{sess.user.name}{(sess.auth_mode === 'sso' || sess.auth_mode === 'websso') && <em className="sso-tag">SSO</em>}</span>
            <button className="btn ghost sm" onClick={logout}><LogOut size={15} /> Đăng xuất</button>
          </div>
        </header>
        <main className="content">
          <Outlet context={{ sess }} />
        </main>
      </div>
      <Toasts />
    </div>
  );
}

function NotifBell() {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  async function load() {
    try { setData(await api('/notifications?limit=30')); } catch { /* im lặng */ }
  }
  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => { clearInterval(t); document.removeEventListener('mousedown', close); };
  }, []);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && data?.unread) { await api('/notifications/read', { method: 'POST' }).catch(() => {}); setTimeout(load, 300); }
  }

  const tone = { ok: 'badge-ok', error: 'badge-err', warn: 'badge-warn', info: 'badge-info' };
  return (
    <div className="menu-wrap" ref={ref}>
      <button className="icon-btn notif-btn" onClick={toggle} aria-label="Thong bao">
        <Bell size={17} />
        {data?.unread > 0 && <em className="notif-dot">{data.unread > 9 ? '9+' : data.unread}</em>}
      </button>
      {open && (
        <div className="menu notif-panel">
          <div className="notif-head">Thông báo</div>
          {!data?.notifications?.length
            ? <p className="dim" style={{ padding: '10px 12px', margin: 0 }}>Chưa có thông báo nào.</p>
            : data.notifications.map((n) => (
              <div key={n.id} className="notif-item">
                <span className={`badge ${tone[n.level] || 'badge-muted'}`}><i /></span>
                <span>
                  <b>{n.title}</b>
                  {n.detail && <em>{n.detail}</em>}
                  <span className="dim">{fmtDate(n.ts)}</span>
                </span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

function ThemeToggle() {
  const [dark, setDark] = useState(() => localStorage.getItem('mbfs-theme') === 'dark');
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    localStorage.setItem('mbfs-theme', dark ? 'dark' : 'light');
  }, [dark]);
  return (
    <button className="icon-btn" onClick={() => setDark(!dark)} title={dark ? 'Chuyển sang giao diện sáng' : 'Chuyển sang giao diện tối'}>
      {dark ? <Sun size={17} /> : <Moon size={17} />}
    </button>
  );
}
