import React, { useEffect, useRef, useState } from 'react';
import { MoreVertical, X, Loader2 } from 'lucide-react';

// ---------- Toast ----------
export function toast(msg, type = 'info') {
  window.dispatchEvent(new CustomEvent('app-toast', { detail: { id: Date.now() + Math.random(), msg, type } }));
}

export function Toasts() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    const on = (e) => {
      const t = e.detail;
      setItems((xs) => [...xs, t]);
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== t.id)), 4500);
    };
    window.addEventListener('app-toast', on);
    return () => window.removeEventListener('app-toast', on);
  }, []);
  return (
    <div className="toasts">
      {items.map((t) => (
        <div key={t.id} className={`toast toast-${t.type}`}>{t.msg}</div>
      ))}
    </div>
  );
}

// ---------- Status badge ----------
const TONES = {
  ACTIVE: 'ok', available: 'ok', active: 'ok', UP: 'ok',
  SHUTOFF: 'muted', DOWN: 'muted', stopped: 'muted',
  ERROR: 'err', error: 'err', error_deleting: 'err',
  BUILD: 'warn', REBOOT: 'warn', HARD_REBOOT: 'warn', RESIZE: 'warn', VERIFY_RESIZE: 'warn',
  creating: 'warn', attaching: 'warn', detaching: 'warn', extending: 'warn', deleting: 'warn', queued: 'warn', saving: 'warn',
  'in-use': 'info', PAUSED: 'info', SHELVED: 'info', SHELVED_OFFLOADED: 'info',
  ONLINE: 'ok', OFFLINE: 'muted', DEGRADED: 'warn', NO_MONITOR: 'info',
  PENDING_CREATE: 'warn', PENDING_UPDATE: 'warn', PENDING_DELETE: 'warn',
};
export function StatusBadge({ status }) {
  const tone = TONES[status] || 'muted';
  return <span className={`badge badge-${tone}`}><i />{status || '—'}</span>;
}

// ---------- Usage bar ----------
export function UsageBar({ label, used, max, unit = '', render }) {
  const pct = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0;
  const tone = pct >= 90 ? 'err' : pct >= 75 ? 'warn' : 'ok';
  const show = render || ((v) => `${v}`);
  return (
    <div className="usage">
      <div className="usage-top">
        <span className="usage-label">{label}</span>
        <span className="usage-val mono">{show(used)} / {show(max)} {unit}</span>
      </div>
      <div className="usage-track"><div className={`usage-fill fill-${tone}`} style={{ width: pct + '%' }} /></div>
    </div>
  );
}

// ---------- Modal ----------
export function Modal({ title, onClose, children, footer, wide, className = '' }) {
  useEffect(() => {
    const esc = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''} ${className}`.trim()} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Đóng"><X size={18} /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

// ---------- Form field ----------
export function Field({ label, hint, children }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

// ---------- Actions menu (⋮) ----------
export function ActionsMenu({ items }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  return (
    <div className="menu-wrap" ref={ref}>
      <button className="icon-btn" onClick={() => setOpen((o) => !o)} aria-label="Hành động"><MoreVertical size={16} /></button>
      {open && (
        <div className="menu">
          {items.filter(Boolean).map((it, i) =>
            it === 'divider' ? <div key={i} className="menu-div" /> : (
              <button key={i} className={`menu-item ${it.danger ? 'danger' : ''}`} disabled={it.disabled}
                onClick={() => { setOpen(false); it.onClick(); }}>
                {it.label}
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}

// ---------- Misc ----------
export function Spinner({ size = 18 }) {
  return <Loader2 className="spin" size={size} />;
}

export function Empty({ children }) {
  return <div className="empty">{children}</div>;
}

export function PageHead({ title, count, onRefresh, children }) {
  return (
    <div className="page-head">
      <h2>{title} {count != null && <span className="count">{count}</span>}</h2>
      <div className="page-actions">
        {onRefresh && <button className="btn ghost" onClick={onRefresh}>Làm mới</button>}
        {children}
      </div>
    </div>
  );
}
