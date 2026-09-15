import React, { useEffect, useState } from 'react';
import { api, ramGB } from '../api.js';
import { Modal, Field, UsageBar, toast, Empty, PageHead } from '../components/ui.jsx';

export default function Admin() {
  const [tab, setTab] = useState('overview');
  return (
    <>
      <PageHead title="Quản trị cụm" />
      <div className="tab-row" style={{ marginBottom: 16 }}>
        {[['overview', 'Tổng quan cụm'], ['projects', 'Projects & Quota'], ['users', 'Users']].map(([k, label]) => (
          <button key={k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{label}</button>
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
  const [data, setData] = useState(null);
  useEffect(() => { api('/admin/overview').then(setData).catch((e) => toast(e.message, 'error')); }, []);
  if (!data) return <Empty>Đang tải…</Empty>;
  const h = data.hypervisors;
  return (
    <>
      {!h ? (
        <div className="card notice-card">Không đọc được thống kê hypervisor: {data.hypervisors_error || 'Nova từ chối (cần role admin toàn cụm)'}.</div>
      ) : (
        <div className="grid-cards">
          <div className="card">
            <h4>Tài nguyên vật lý toàn cụm</h4>
            <UsageBar label={`vCPU (${h.count} hypervisor)`} used={h.vcpus_used} max={h.vcpus} />
            <UsageBar label="RAM" used={h.memory_mb_used} max={h.memory_mb} render={(x) => ramGB(x)} />
            <UsageBar label="Đĩa local" used={h.local_gb_used} max={h.local_gb} unit="GB" />
          </div>
          <div className="card stat"><span className="stat-label">VM đang chạy toàn cụm</span><span className="stat-val mono">{h.running_vms}</span></div>
          <div className="card stat"><span className="stat-label">Hypervisor</span><span className="stat-val mono">{h.count}</span>
            <span className="stat-sub dim">Tỉ lệ cấp phát vCPU {Math.round((h.vcpus_used / h.vcpus) * 100)}% · RAM {Math.round((h.memory_mb_used / h.memory_mb) * 100)}%</span></div>
          <div className="card stat"><span className="stat-label">Projects</span><span className="stat-val mono">{data.projects.length}</span></div>
        </div>
      )}
    </>
  );
}

// ---------- Projects & Quota ----------
const QUOTA_FIELDS = [
  ['instances', 'Máy ảo'], ['cores', 'vCPU'], ['ram', 'RAM (MB)'],
  ['volumes', 'Số volume'], ['gigabytes', 'Volume (GB)'], ['snapshots', 'Snapshot'],
  ['floatingip', 'Floating IP'], ['network', 'Network'], ['security_group', 'Security group'],
];

function Projects() {
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
      toast('Đã cập nhật quota', 'ok');
    } catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  }

  return (
    <div className="split">
      <div className="card split-left">
        <button className="btn sm primary block" style={{ marginBottom: 8 }} onClick={() => setCreating(true)}>+ Tạo project</button>
        {(projects || []).map((p) => (
          <button key={p.id} className={`sg-item ${p.id === selId ? 'active' : ''}`} onClick={() => setSelId(p.id)}>
            <b>{p.name}</b><span className="dim mono">{p.id.slice(0, 12)}…</span>
          </button>
        ))}
      </div>
      <div className="card split-right">
        {!selId ? <Empty>Chọn project.</Empty> : !quota ? <Empty>Đang tải quota…</Empty> : (
          <>
            <div className="card-head"><h4>Quota — {projects.find((p) => p.id === selId)?.name}</h4>
              <button className="btn sm primary" onClick={saveQuota} disabled={busy}>{busy ? 'Đang lưu…' : 'Lưu quota'}</button></div>
            <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
              {QUOTA_FIELDS.map(([k, label]) => (
                <Field key={k} label={label}>
                  <input type="number" className="mono" value={quota[k] ?? ''} placeholder="—"
                    onChange={(e) => setQuota({ ...quota, [k]: e.target.value })} />
                </Field>
              ))}
            </div>
            <p className="dim">-1 = không giới hạn. Bỏ trống = giữ nguyên giá trị hiện tại.</p>
          </>
        )}
      </div>
      {creating && <CreateProject onClose={() => setCreating(false)} onDone={() => { setCreating(false); load(); }} />}
    </div>
  );
}

function CreateProject({ onClose, onDone }) {
  const [f, setF] = useState({ name: '', description: '' });
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!f.name.trim()) return toast('Nhập tên project', 'error');
    setBusy(true);
    try { await api('/admin/projects', { method: 'POST', body: f }); toast(`Đã tạo project ${f.name}`, 'ok'); onDone(); }
    catch (e) { toast(e.message, 'error'); setBusy(false); }
  }
  return (
    <Modal title="Tạo project" onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Huỷ</button>
        <button className="btn primary" onClick={submit} disabled={busy}>Tạo project</button></>}>
      <Field label="Tên project"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="vd: team-qa" autoFocus /></Field>
      <Field label="Mô tả"><input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      <p className="dim">Sau khi tạo, sang tab Users để gán người dùng vào project (role member).</p>
    </Modal>
  );
}

// ---------- Users ----------
function Users() {
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
    const pw = window.prompt(`Mật khẩu mới cho ${u.name} (≥8 ký tự):`);
    if (!pw) return;
    try { await api(`/admin/users/${u.id}/password`, { method: 'POST', body: { password: pw } }); toast('Đã đổi mật khẩu', 'ok'); }
    catch (e) { toast(e.message, 'error'); }
  }

  return (
    <div className="card">
      <div className="card-head"><h4>Người dùng Keystone</h4>
        <button className="btn sm primary" onClick={() => setCreating(true)}>+ Tạo user</button></div>
      {!users ? <Empty>Đang tải…</Empty> : (
        <table className="tbl">
          <thead><tr><th>Tên</th><th>Trạng thái</th><th>Email</th><th /></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td><b>{u.name}</b></td>
                <td className="dim">{u.enabled ? 'Hoạt động' : 'Khoá'}</td>
                <td className="dim">{u.email || '—'}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn sm" onClick={() => setAssignFor(u)}>Gán project</button>{' '}
                  <button className="btn sm ghost" onClick={() => resetPass(u)}>Đổi mật khẩu</button>
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
  const [f, setF] = useState({ name: '', password: '' });
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try { await api('/admin/users', { method: 'POST', body: f }); toast(`Đã tạo user ${f.name} — nhớ gán vào project`, 'ok'); onDone(); }
    catch (e) { toast(e.message, 'error'); setBusy(false); }
  }
  return (
    <Modal title="Tạo user Keystone" onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Huỷ</button>
        <button className="btn primary" onClick={submit} disabled={busy}>Tạo user</button></>}>
      <Field label="Tên đăng nhập"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /></Field>
      <Field label="Mật khẩu (≥8 ký tự)"><input type="password" autoComplete="new-password" className="mono" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
    </Modal>
  );
}

function AssignModal({ user, projects, onClose }) {
  const [f, setF] = useState({ project_id: projects[0]?.id || '', role: 'member' });
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try {
      await api('/admin/assign', { method: 'POST', body: { user_id: user.id, ...f } });
      toast(`Đã gán ${user.name} vào project (${f.role})`, 'ok');
      onClose();
    } catch (e) { toast(e.message, 'error'); setBusy(false); }
  }
  return (
    <Modal title={`Gán project — ${user.name}`} onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Huỷ</button>
        <button className="btn primary" onClick={submit} disabled={busy || !f.project_id}>Gán</button></>}>
      <Field label="Project">
        <select value={f.project_id} onChange={(e) => setF({ ...f, project_id: e.target.value })}>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </Field>
      <Field label="Role">
        <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
          <option value="member">member — dùng portal bình thường</option>
          <option value="admin">admin — kèm quyền quản trị cụm</option>
        </select>
      </Field>
    </Modal>
  );
}
