import React, { useEffect, useState } from 'react';
import { api, ramGB } from '../api.js';
import { Modal, Field, UsageBar, toast, Empty, PageHead } from '../components/ui.jsx';
import { useI18n } from '../i18n/react.jsx';

export default function Admin() {
  const { t } = useI18n();
  const [tab, setTab] = useState('overview');
  return (
    <>
      <PageHead title={t('navigation.admin')} />
      <div className="tab-row" style={{ marginBottom: 16 }}>
        {['overview', 'projects', 'users'].map((key) => (
          <button key={key} className={`tab ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)}>{t(`admin.tab.${key}`)}</button>
        ))}
      </div>
      {tab === 'overview' && <Overview />}
      {tab === 'projects' && <Projects />}
      {tab === 'users' && <Users />}
    </>
  );
}

// ---------- Tổng quan hypervisor ----------
function Overview() {
  const { t, locale } = useI18n();
  const [data, setData] = useState(null);
  useEffect(() => { api('/admin/overview').then(setData).catch((e) => toast(e.message, 'error')); }, []);
  if (!data) return <Empty>{t('common.loading')}</Empty>;
  const h = data.hypervisors;
  return (
    <>
      {!h ? (
        <div className="card notice-card">{t('admin.hypervisorUnavailable')} {locale === 'vi' ? data.hypervisors_error || t('admin.novaDenied') : t('admin.novaDenied')}</div>
      ) : (
        <div className="grid-cards">
          <div className="card">
            <h4>{t('admin.clusterResources')}</h4>
            <UsageBar label={t(h.count === 1 ? 'admin.hypervisorCount.one' : 'admin.hypervisorCount.other', { count: h.count })} used={h.vcpus_used} max={h.vcpus} />
            <UsageBar label="RAM" used={h.memory_mb_used} max={h.memory_mb} render={(x) => ramGB(x)} />
            <UsageBar label={t('admin.localDisk')} used={h.local_gb_used} max={h.local_gb} unit="GB" />
          </div>
          <div className="card stat"><span className="stat-label">{t('admin.runningVms')}</span><span className="stat-val mono">{h.running_vms}</span></div>
          <div className="card stat"><span className="stat-label">Hypervisor</span><span className="stat-val mono">{h.count}</span>
            <span className="stat-sub dim">{t('admin.allocationRate')} vCPU {Math.round((h.vcpus_used / h.vcpus) * 100)}% · RAM {Math.round((h.memory_mb_used / h.memory_mb) * 100)}%</span></div>
          <div className="card stat"><span className="stat-label">Projects</span><span className="stat-val mono">{data.projects.length}</span></div>
        </div>
      )}
    </>
  );
}

// ---------- Projects & Quota ----------
const QUOTA_FIELDS = [
  ['instances', 'navigation.instances'], ['cores', 'admin.vcpu'], ['ram', 'admin.ram'],
  ['volumes', 'admin.volumeCount'], ['gigabytes', 'admin.volumeCapacity'], ['snapshots', 'admin.snapshots'],
  ['floatingip', 'navigation.floatingIps'], ['network', 'admin.network'], ['security_group', 'admin.securityGroup'],
];

function Projects() {
  const { t } = useI18n();
  const [projects, setProjects] = useState(null);
  const [selId, setSelId] = useState(null);
  const [quota, setQuota] = useState(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);

  async function load() {
    try {
      const d = await api('/admin/overview');
      setProjects(d.projects);
      if (d.projects.length && !selId) setSelId(d.projects[0].id);
    } catch (e) { toast(e.message, 'error'); }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line
  useEffect(() => {
    if (!selId) return;
    setQuota(null);
    api(`/admin/projects/${selId}/quota`).then((d) => setQuota(d.quota)).catch((e) => toast(e.message, 'error'));
  }, [selId]);

  async function saveQuota() {
    setBusy(true);
    try {
      await api(`/admin/projects/${selId}/quota`, { method: 'PUT', body: quota });
      toast(t('admin.quotaUpdated'), 'ok');
    } catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  }

  return (
    <div className="split">
      <div className="card split-left">
        <button className="btn sm primary block" style={{ marginBottom: 8 }} onClick={() => setCreating(true)}>+ {t('admin.createProject')}</button>
        {(projects || []).map((p) => (
          <button key={p.id} className={`sg-item ${p.id === selId ? 'active' : ''}`} onClick={() => setSelId(p.id)}>
            <b>{p.name}</b><span className="dim mono">{p.id.slice(0, 12)}…</span>
          </button>
        ))}
      </div>
      <div className="card split-right">
        {!selId ? <Empty>{t('admin.selectProject')}</Empty> : !quota ? <Empty>{t('admin.loadingQuota')}</Empty> : (
          <>
            <div className="card-head"><h4>Quota — {projects.find((p) => p.id === selId)?.name}</h4>
              <button className="btn sm primary" onClick={saveQuota} disabled={busy}>{t(busy ? 'admin.saving' : 'admin.saveQuota')}</button></div>
            <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
              {QUOTA_FIELDS.map(([k, labelKey]) => (
                <Field key={k} label={t(labelKey)}>
                  <input type="number" className="mono" value={quota[k] ?? ''} placeholder="—"
                    onChange={(e) => setQuota({ ...quota, [k]: e.target.value })} />
                </Field>
              ))}
            </div>
            <p className="dim">{t('admin.quotaHint')}</p>
          </>
        )}
      </div>
      {creating && <CreateProject onClose={() => setCreating(false)} onDone={() => { setCreating(false); load(); }} />}
    </div>
  );
}

function CreateProject({ onClose, onDone }) {
  const { t } = useI18n();
  const [f, setF] = useState({ name: '', description: '' });
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!f.name.trim()) return toast(t('admin.projectNameRequired'), 'error');
    setBusy(true);
    try { await api('/admin/projects', { method: 'POST', body: f }); toast(t('admin.projectCreated', { name: f.name }), 'ok'); onDone(); }
    catch (e) { toast(e.message, 'error'); setBusy(false); }
  }
  return (
    <Modal title={t('admin.createProject')} onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn primary" onClick={submit} disabled={busy}>{t('admin.createProject')}</button></>}>
      <Field label={t('billing.projectName')}><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. team-qa" autoFocus /></Field>
      <Field label={t('securityGroups.description')}><input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      <p className="dim">{t('admin.projectHint')}</p>
    </Modal>
  );
}

// ---------- Users ----------
function Users() {
  const { t } = useI18n();
  const [users, setUsers] = useState(null);
  const [projects, setProjects] = useState([]);
  const [creating, setCreating] = useState(false);
  const [assignFor, setAssignFor] = useState(null);

  async function load() {
    try {
      const [u, o] = await Promise.all([api('/admin/users'), api('/admin/overview')]);
      setUsers(u.users); setProjects(o.projects);
    } catch (e) { toast(e.message, 'error'); }
  }
  useEffect(() => { load(); }, []);

  async function resetPass(u) {
    const pw = window.prompt(t('admin.passwordPrompt', { name: u.name }));
    if (!pw) return;
    try { await api(`/admin/users/${u.id}/password`, { method: 'POST', body: { password: pw } }); toast(t('admin.passwordChanged'), 'ok'); }
    catch (e) { toast(e.message, 'error'); }
  }

  return (
    <div className="card">
      <div className="card-head"><h4>{t('admin.keystoneUsers')}</h4>
        <button className="btn sm primary" onClick={() => setCreating(true)}>+ {t('admin.createUser')}</button></div>
      {!users ? <Empty>{t('common.loading')}</Empty> : (
        <table className="tbl">
          <thead><tr><th>{t('common.name')}</th><th>{t('common.status')}</th><th>Email</th><th /></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td><b>{u.name}</b></td>
                <td className="dim">{t(u.enabled ? 'admin.active' : 'admin.locked')}</td>
                <td className="dim">{u.email || '—'}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn sm" onClick={() => setAssignFor(u)}>{t('admin.assignProject')}</button>{' '}
                  <button className="btn sm ghost" onClick={() => resetPass(u)}>{t('instances.changePassword')}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {creating && <CreateUser onClose={() => setCreating(false)} onDone={() => { setCreating(false); load(); }} />}
      {assignFor && <AssignModal user={assignFor} projects={projects} onClose={() => setAssignFor(null)} />}
    </div>
  );
}

function CreateUser({ onClose, onDone }) {
  const { t } = useI18n();
  const [f, setF] = useState({ name: '', password: '' });
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try { await api('/admin/users', { method: 'POST', body: f }); toast(t('admin.userCreated', { name: f.name }), 'ok'); onDone(); }
    catch (e) { toast(e.message, 'error'); setBusy(false); }
  }
  return (
    <Modal title={t('admin.createUserTitle')} onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn primary" onClick={submit} disabled={busy}>{t('admin.createUser')}</button></>}>
      <Field label={t('auth.username')}><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /></Field>
      <Field label={t('admin.passwordMinimum')}><input type="password" autoComplete="new-password" className="mono" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
    </Modal>
  );
}

function AssignModal({ user, projects, onClose }) {
  const { t } = useI18n();
  const [f, setF] = useState({ project_id: projects[0]?.id || '', role: 'member' });
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try {
      await api('/admin/assign', { method: 'POST', body: { user_id: user.id, ...f } });
      toast(t('admin.assigned', { name: user.name, role: f.role }), 'ok');
      onClose();
    } catch (e) { toast(e.message, 'error'); setBusy(false); }
  }
  return (
    <Modal title={t('admin.assignTitle', { name: user.name })} onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn primary" onClick={submit} disabled={busy || !f.project_id}>{t('admin.assign')}</button></>}>
      <Field label="Project">
        <select value={f.project_id} onChange={(e) => setF({ ...f, project_id: e.target.value })}>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </Field>
      <Field label="Role">
        <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
          <option value="member">{t('admin.memberRole')}</option>
          <option value="admin">{t('admin.adminRole')}</option>
        </select>
      </Field>
    </Modal>
  );
}
