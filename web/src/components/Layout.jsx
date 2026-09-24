import React, { useEffect, useRef, useState } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { Bell, Moon, Sun, LogOut } from 'lucide-react';
import { api, fmtDate } from '../api.js';
import { Toasts, toast } from './ui.jsx';
import useCmpSession from '../useCmpSession.js';
import { useI18n } from '../i18n/react.jsx';
import LanguageSwitcher from './LanguageSwitcher.jsx';
import { noticeDetail, noticeTitle } from '../i18n/notifications.js';
import SidebarNavigation from './SidebarNavigation.jsx';

export default function Layout() {
  const { t } = useI18n();
  const sess = useCmpSession();
  const [cfg, setCfg] = useState({ cloudName: 'MBFS Cloud' });
  const [switchingProject, setSwitchingProject] = useState(false);
  const nav = useNavigate();

  useEffect(() => {
    api('/auth/config').then(setCfg).catch(() => {});
  }, []);

  async function switchProject(projectId) {
    if (switchingProject || projectId === sess?.project?.id) return;
    setSwitchingProject(true);
    try {
      const path = sess?.auth_mode === 'sso' ? '/auth/sso/switch-project' : '/auth/switch-project';
      await api(path, { method: 'POST', body: { projectId } });
      window.location.reload();
    } catch (e) {
      setSwitchingProject(false);
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

  if (!sess) return <div className="boot">{t('common.loading')}</div>;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-logo brand-logo-full" src="/asset/logo.png" alt="MobiFone Solutions Cloud" />
          <img className="brand-logo brand-logo-mark" src="/asset/favicon.png" alt="" aria-hidden="true" />
        </div>
        <SidebarNavigation config={cfg} roles={sess.roles} />
        <div className="sidebar-foot">
          {cfg.mock && <div className="mock-flag">{t('common.demoMode')}</div>}
          <span className="ver">portal v2.4</span>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="topbar-left">
            <span className="tb-label">{t('common.project')}</span>
            <select className="project-select" value={sess.project.id} disabled={switchingProject} onChange={(e) => switchProject(e.target.value)}>
              {sess.projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <div className="topbar-right">
            <LanguageSwitcher />
            <ThemeToggle />
            <NotifBell />
            <span className="user-chip">{sess.user.name}{(sess.auth_mode === 'sso' || sess.auth_mode === 'websso') && <em className="sso-tag">SSO</em>}</span>
            <button className="btn ghost sm" onClick={logout}><LogOut size={15} /> {t('header.logout')}</button>
          </div>
        </header>
        <main className="content">
          {switchingProject ? <div className="boot">{t('common.loading')}</div> : <Outlet context={{ sess }} />}
        </main>
      </div>
      <Toasts />
    </div>
  );
}

function NotifBell() {
  const { t, locale } = useI18n();
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
      <button className="icon-btn notif-btn" onClick={toggle} aria-label={t('header.notifications')}>
        <Bell size={17} />
        {data?.unread > 0 && <em className="notif-dot">{data.unread > 9 ? '9+' : data.unread}</em>}
      </button>
      {open && (
        <div className="menu notif-panel">
          <div className="notif-head">{t('header.notifications')}</div>
          {!data?.notifications?.length
            ? <p className="dim" style={{ padding: '10px 12px', margin: 0 }}>{t('header.noNotifications')}</p>
            : data.notifications.map((n) => (
              <div key={n.id} className="notif-item">
                <span className={`badge ${tone[n.level] || 'badge-muted'}`}><i /></span>
                <span>
                  <b>{noticeTitle(n, locale)}</b>
                  {noticeDetail(n, locale) && <em>{noticeDetail(n, locale)}</em>}
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
  const { t } = useI18n();
  const [dark, setDark] = useState(() => localStorage.getItem('mbfs-theme') === 'dark');
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    localStorage.setItem('mbfs-theme', dark ? 'dark' : 'light');
  }, [dark]);
  return (
    <button className="icon-btn" onClick={() => setDark(!dark)} title={dark ? t('header.lightTheme') : t('header.darkTheme')}>
      {dark ? <Sun size={17} /> : <Moon size={17} />}
    </button>
  );
}
