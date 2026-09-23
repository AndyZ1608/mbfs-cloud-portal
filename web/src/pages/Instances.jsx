import React, { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { api, fmtDate, ramGB, serverIps } from '../api.js';
import { Modal, Field, StatusBadge, ActionsMenu, toast, Empty, PageHead } from '../components/ui.jsx';
import MonitorModal from '../components/MonitorModal.jsx';
import TypeToConfirmDialog from '../components/TypeToConfirmDialog.jsx';
import { openInstanceConsole } from '../console/navigation.js';

export default function Instances() {
  const [servers, setServers] = useState(null);
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState(null);
  const [fipTarget, setFipTarget] = useState(null);
  const [resizeFor, setResizeFor] = useState(null);
  const [logFor, setLogFor] = useState(null);
  const [rebuildFor, setRebuildFor] = useState(null);
  const [nicFor, setNicFor] = useState(null);
  const [sgFor, setSgFor] = useState(null);
  const [q, setQ] = useState('');
  const [monFor, setMonFor] = useState(null);
  const [monStatus, setMonStatus] = useState(null);
  const [latest, setLatest] = useState({});
  const [deleteFor, setDeleteFor] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const deleteRequest = useRef(false);
  const timer = useRef(null);

  async function load() {
    try {
      const d = await api('/servers');
      setServers(d.servers);
      api('/monitor/latest').then((m) => setLatest(m.latest || {})).catch(() => {});
    } catch (e) { toast(e.message, 'error'); }
  }

  useEffect(() => {
    load();
    api('/monitor/status').then(setMonStatus).catch(() => {});
    timer.current = setInterval(load, 10000);
    return () => clearInterval(timer.current);
  }, []);

  async function act(s, action, label) {
    try {
      await api(`/servers/${s.id}/action`, { method: 'POST', body: { action } });
      toast(`${label}: ${s.name}`, 'ok');
      setTimeout(load, 800);
    } catch (e) { toast(e.message, 'error'); }
  }

  function openDelete(s) {
    deleteRequest.current = false;
    setDeleting(false);
    setDeleteFor(s);
  }

  function closeDelete() {
    if (deleteRequest.current) return;
    setDeleteFor(null);
    setDeleting(false);
  }

  async function confirmDelete() {
    const s = deleteFor;
    if (!s || deleteRequest.current) return;
    deleteRequest.current = true;
    setDeleting(true);
    try {
      await api(`/servers/${s.id}`, { method: 'DELETE' });
      toast(`Đã gửi lệnh xoá ${s.name}`, 'ok');
      setDeleteFor(null);
      setTimeout(load, 800);
    } catch (e) {
      toast(e.message, 'error');
      deleteRequest.current = false;
      setDeleting(false);
    }
  }

  useEffect(() => {
    if (!deleteFor || !servers) return;
    const current = servers.find((server) => server.id === deleteFor.id);
    if (!current) {
      if (!deleteRequest.current) setDeleteFor(null);
      return;
    }
    if (current.name !== deleteFor.name) setDeleteFor(current);
  }, [servers, deleteFor]);

  async function rename(s) {
    const name = window.prompt('Tên mới cho máy ảo:', s.name);
    if (!name || name.trim() === s.name) return;
    try {
      await api(`/servers/${s.id}`, { method: 'PUT', body: { name: name.trim() } });
      toast(`Đã đổi tên thành "${name.trim()}"`, 'ok');
      load();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function snapshot(s) {
    const name = window.prompt('Tên snapshot (image):', `${s.name}-snap-${new Date().toISOString().slice(0, 10)}`);
    if (!name) return;
    try {
      await api(`/servers/${s.id}/action`, { method: 'POST', body: { action: 'snapshot', name } });
      toast(`Đang tạo snapshot "${name}" — xem ở mục Images`, 'ok');
    } catch (e) { toast(e.message, 'error'); }
  }
  const shown = !servers ? null : servers.filter((s) => {
    const t = q.trim().toLowerCase();
    if (!t) return true;
    return (s.name || '').toLowerCase().includes(t) || serverIps(s).some((x) => x.ip.includes(t));
  });

  return (
    <>
      <PageHead title="Máy ảo" count={shown?.length} onRefresh={load}>
        <input placeholder="Tìm tên / IP…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 190 }} />
        <button className="btn primary" onClick={() => setCreating(true)}><Plus size={16} /> Tạo máy ảo</button>
      </PageHead>

      {!servers ? <Empty>Đang tải…</Empty> : shown.length === 0 ? (
        <Empty>Chưa có máy ảo nào trong project này. Bấm “Tạo máy ảo” để bắt đầu.</Empty>
      ) : (
        <div className="card">
          <table className="tbl">
            <thead><tr><th>Tên</th><th>Trạng thái</th><th>CPU</th><th>Địa chỉ IP</th><th>Cấu hình</th><th>SSH key</th><th>Tạo lúc</th><th /></tr></thead>
            <tbody>
              {shown.map((s) => (
                <tr key={s.id}>
                  <td><button className="link-btn" onClick={() => setDetail(s)}>{s.name}</button></td>
                  <td><StatusBadge status={s.status} />{s['OS-EXT-STS:task_state'] && <span className="dim task"> {s['OS-EXT-STS:task_state']}…</span>}</td>
                  <td>{latest[s.id] ? (
                    <button className={`cpu-chip cpu-${latest[s.id].cpu >= 90 ? 'hot' : latest[s.id].cpu >= 70 ? 'warm' : 'ok'}`}
                      onClick={() => setMonFor(s)} title="Xem biểu đồ giám sát">{latest[s.id].cpu}%</button>
                  ) : <span className="dim">—</span>}</td>
                  <td>{serverIps(s).map((x) => (
                    <span key={x.ip} className={`mono chip ${x.type === 'floating' ? 'chip-fip' : ''}`} title={`${x.net} (${x.type})`}>{x.ip}</span>
                  ))}</td>
                  <td className="dim">{s.flavor?.original_name || s.flavor?.id || '—'}
                    {s.flavor?.vcpus != null && <span className="dim"> · {s.flavor.vcpus} vCPU / {ramGB(s.flavor.ram)}</span>}
                  </td>
                  <td className="dim">{s.key_name || '—'}</td>
                  <td className="dim">{fmtDate(s.created)}</td>
                  <td>
                    <ActionsMenu items={[
                      s.status === 'VERIFY_RESIZE' && { label: '✓ Xác nhận resize', onClick: () => act(s, 'confirm-resize', 'Đã xác nhận resize') },
                      s.status === 'VERIFY_RESIZE' && { label: 'Hoàn tác resize', onClick: () => act(s, 'revert-resize', 'Đã hoàn tác resize') },
                      s.status === 'VERIFY_RESIZE' && 'divider',
                      s.status !== 'ACTIVE' && s.status !== 'VERIFY_RESIZE' && { label: 'Bật máy', onClick: () => act(s, 'start', 'Đã bật') },
                      s.status === 'ACTIVE' && { label: 'Tắt máy', onClick: () => act(s, 'stop', 'Đã gửi lệnh tắt') },
                      s.status === 'ACTIVE' && { label: 'Khởi động lại (mềm)', onClick: () => act(s, 'reboot-soft', 'Đang khởi động lại') },
                      s.status === 'ACTIVE' && { label: 'Khởi động lại (cứng)', onClick: () => act(s, 'reboot-hard', 'Đang khởi động lại') },
                      (s.status === 'ACTIVE' || s.status === 'SHUTOFF') && { label: 'Đổi cấu hình (resize)', onClick: () => setResizeFor(s) },
                      { label: 'Đổi tên', onClick: () => rename(s) },
                      { label: 'Mở console', onClick: () => openInstanceConsole(s.id) },
                      { label: 'Biểu đồ giám sát', onClick: () => setMonFor(s) },
                      { label: 'Xem log console', onClick: () => setLogFor(s) },
                      { label: 'Quản lý card mạng', onClick: () => setNicFor(s) },
                      { label: 'Đổi security group', onClick: () => setSgFor(s) },
                      (s.status === 'ACTIVE' || s.status === 'SHUTOFF') && { label: 'Cài lại HĐH (rebuild)', onClick: () => setRebuildFor(s) },
                      s.status === 'ACTIVE' && { label: 'Shelve (tắt sâu, giải phóng tài nguyên)', onClick: () => act(s, 'shelve', 'Đang shelve') },
                      (s.status === 'SHELVED' || s.status === 'SHELVED_OFFLOADED') && { label: 'Unshelve (khôi phục)', onClick: () => act(s, 'unshelve', 'Đang khôi phục') },
                      { label: 'Tạo snapshot', onClick: () => snapshot(s) },
                      { label: 'Gắn Floating IP', onClick: () => setFipTarget(s) },
                      'divider',
                      { label: 'Xoá máy ảo', danger: true, onClick: () => openDelete(s) },
                    ]} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && <CreateModal onClose={() => setCreating(false)} onDone={() => { setCreating(false); load(); }} />}
      {detail && <DetailModal server={detail} onClose={() => setDetail(null)} />}
      {fipTarget && <FipModal server={fipTarget} onClose={() => setFipTarget(null)} onDone={() => { setFipTarget(null); load(); }} />}
      {resizeFor && <ResizeModal server={resizeFor} onClose={() => setResizeFor(null)} onDone={() => { setResizeFor(null); setTimeout(load, 800); }} />}
      {logFor && <ConsoleLogModal server={logFor} onClose={() => setLogFor(null)} />}
      {monFor && <MonitorModal server={monFor} status={monStatus} onClose={() => setMonFor(null)} />}
      {rebuildFor && <RebuildModal server={rebuildFor} onClose={() => setRebuildFor(null)} onDone={() => { setRebuildFor(null); setTimeout(load, 800); }} />}
      {nicFor && <NicModal server={nicFor} onClose={() => setNicFor(null)} onDone={load} />}
      {sgFor && <SgModal server={sgFor} onClose={() => setSgFor(null)} onDone={() => { setSgFor(null); load(); }} />}
      {deleteFor && <TypeToConfirmDialog
        title="Xoá máy ảo"
        description="Máy ảo và dữ liệu trên đĩa gốc sẽ bị xoá vĩnh viễn. Hành động này không thể hoàn tác."
        resourceName={deleteFor.name}
        resourceId={deleteFor.id}
        confirmLabel="Xoá máy ảo"
        loading={deleting}
        onConfirm={confirmDelete}
        onCancel={closeDelete}
      />}
    </>
  );
}

// ---------- Tạo máy ảo ----------
function CreateModal({ onClose, onDone }) {
  const [opts, setOpts] = useState(null);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({
    name: '', flavorRef: '', imageRef: '', networks: [], key_name: '',
    security_groups: ['default'], count: 1, bfv: false, boot_volume_gb: 40,
    show_ud: false, user_data: '',
  });

  useEffect(() => {
    Promise.all([api('/flavors'), api('/images'), api('/networks'), api('/keypairs'), api('/security-groups')])
      .then(([fl, im, ne, kp, sg]) => {
        const nets = ne.networks.filter((n) => !n['router:external']);
        setOpts({
          flavors: fl.flavors,
          images: im.images.filter((i) => i.status === 'active'),
          networks: nets,
          keypairs: kp.keypairs,
          secgroups: sg.security_groups,
        });
        setF((x) => ({
          ...x,
          flavorRef: fl.flavors[0]?.id || '',
          imageRef: im.images[0]?.id || '',
          networks: nets[0] ? [nets[0].id] : [],
          key_name: kp.keypairs[0]?.name || '',
        }));
      })
      .catch((e) => toast(e.message, 'error'));
  }, []);

  function toggle(list, v) {
    return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
  }

  async function submit() {
    if (!f.name.trim()) return toast('Nhập tên máy ảo', 'error');
    if (!f.networks.length) return toast('Chọn ít nhất một network', 'error');
    setBusy(true);
    try {
      await api('/servers', {
        method: 'POST',
        body: {
          name: f.name.trim(), flavorRef: f.flavorRef, imageRef: f.imageRef,
          networks: f.networks, key_name: f.key_name || undefined,
          security_groups: f.security_groups, count: Number(f.count) || 1,
          boot_volume_gb: f.bfv ? Number(f.boot_volume_gb) : undefined,
          user_data: f.show_ud && f.user_data.trim() ? f.user_data : undefined,
        },
      });
      toast(`Đang khởi tạo "${f.name}"…`, 'ok');
      onDone();
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  }

  return (
    <Modal title="Tạo máy ảo mới" onClose={onClose} wide
      footer={<>
        <button className="btn ghost" onClick={onClose}>Huỷ</button>
        <button className="btn primary" onClick={submit} disabled={busy || !opts}>{busy ? 'Đang tạo…' : 'Tạo máy ảo'}</button>
      </>}>
      {!opts ? <p>Đang tải tuỳ chọn…</p> : (
        <div className="form-grid">
          <Field label="Tên máy ảo">
            <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="vd: web-portal-02" autoFocus />
          </Field>
          <Field label="Số lượng" hint="Tạo nhiều máy cùng cấu hình (tối đa 10)">
            <input type="number" min="1" max="10" value={f.count} onChange={(e) => setF({ ...f, count: e.target.value })} />
          </Field>
          <Field label="Image (hệ điều hành)">
            <select value={f.imageRef} onChange={(e) => setF({ ...f, imageRef: e.target.value })}>
              {opts.images.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select>
          </Field>
          <Field label="Cấu hình (flavor)">
            <select value={f.flavorRef} onChange={(e) => setF({ ...f, flavorRef: e.target.value })}>
              {opts.flavors.map((x) => <option key={x.id} value={x.id}>{x.name} — {x.vcpus} vCPU / {ramGB(x.ram)} / {x.disk} GB</option>)}
            </select>
          </Field>
          <Field label="SSH key">
            <select value={f.key_name} onChange={(e) => setF({ ...f, key_name: e.target.value })}>
              <option value="">— Không dùng —</option>
              {opts.keypairs.map((k) => <option key={k.name} value={k.name}>{k.name}</option>)}
            </select>
          </Field>
          <Field label="Boot từ volume" hint="Tạo volume mới từ image, giữ được đĩa khi rebuild">
            <div className="row-inline">
              <input type="checkbox" checked={f.bfv} onChange={(e) => setF({ ...f, bfv: e.target.checked })} id="bfv" />
              <label htmlFor="bfv">Bật</label>
              {f.bfv && <><input type="number" min="10" style={{ width: 90 }} value={f.boot_volume_gb}
                onChange={(e) => setF({ ...f, boot_volume_gb: e.target.value })} /> <span className="dim">GB</span></>}
            </div>
          </Field>
          <Field label="Network (chọn một hoặc nhiều)">
            <div className="check-list">
              {opts.networks.map((n) => (
                <label key={n.id} className="check-item">
                  <input type="checkbox" checked={f.networks.includes(n.id)} onChange={() => setF({ ...f, networks: toggle(f.networks, n.id) })} />
                  <span>{n.name}</span>
                  <span className="mono dim">{n.subnet_details?.map((s) => s.cidr).join(', ')}</span>
                </label>
              ))}
              {opts.networks.length === 0 && <p className="dim">Chưa có network nội bộ — tạo ở mục “Mạng & Router”.</p>}
            </div>
          </Field>
          <Field label="Script khởi tạo (cloud-init user-data)" hint="Chạy một lần khi máy boot lần đầu — cài phần mềm, cấu hình tự động">
            <label className="check-item" style={{ marginBottom: 6 }}>
              <input type="checkbox" checked={f.show_ud} onChange={(e) => setF({ ...f, show_ud: e.target.checked })} /> Thêm script
            </label>
            {f.show_ud && (
              <textarea className="mono" rows={6} value={f.user_data} onChange={(e) => setF({ ...f, user_data: e.target.value })}
                placeholder={'#!/bin/bash\napt update && apt install -y nginx\n# hoặc #cloud-config'} />
            )}
          </Field>
          <Field label="Security group">
            <div className="check-list">
              {opts.secgroups.map((g) => (
                <label key={g.id} className="check-item">
                  <input type="checkbox" checked={f.security_groups.includes(g.name)} onChange={() => setF({ ...f, security_groups: toggle(f.security_groups, g.name) })} />
                  <span>{g.name}</span>
                  <span className="dim">{g.description}</span>
                </label>
              ))}
            </div>
          </Field>
        </div>
      )}
    </Modal>
  );
}

// ---------- Chi tiết máy ảo ----------
function DetailModal({ server, onClose }) {
  const [s, setS] = useState(server);
  const [vols, setVols] = useState(null);

  useEffect(() => {
    api(`/servers/${server.id}`).then((d) => setS(d.server)).catch(() => {});
    api('/volumes').then((d) => setVols(d.volumes)).catch(() => setVols([]));
  }, [server.id]);

  const attached = (s['os-extended-volumes:volumes_attached'] || []).map((a) => {
    const v = (vols || []).find((x) => x.id === a.id);
    return v ? `${v.name || v.id.slice(0, 8)} (${v.size} GB)` : a.id;
  });

  return (
    <Modal title={s.name} onClose={onClose}>
      <div className="kv">
        <div><span>ID</span><span className="mono">{s.id}</span></div>
        <div><span>Trạng thái</span><span><StatusBadge status={s.status} /></span></div>
        <div><span>Cấu hình</span><span>{s.flavor?.original_name || s.flavor?.id} {s.flavor?.vcpus != null && `· ${s.flavor.vcpus} vCPU / ${ramGB(s.flavor.ram)} / ${s.flavor.disk} GB`}</span></div>
        <div><span>Địa chỉ IP</span><span>{serverIps(s).map((x) => <span key={x.ip} className="mono chip">{x.ip} <em className="dim">({x.type})</em></span>)}</span></div>
        <div><span>Security group</span><span>{(s.security_groups || []).map((g) => g.name).join(', ') || '—'}</span></div>
        <div><span>SSH key</span><span>{s.key_name || '—'}</span></div>
        <div><span>Volume gắn kèm</span><span>{attached.length ? attached.join(', ') : '—'}</span></div>
        <div><span>Availability zone</span><span>{s['OS-EXT-AZ:availability_zone'] || '—'}</span></div>
        <div><span>Tạo lúc</span><span>{fmtDate(s.created)}</span></div>
        {s.fault?.message && <div><span>Lỗi</span><span className="err-text">{s.fault.message}</span></div>}
      </div>
    </Modal>
  );
}

// ---------- Đổi cấu hình (resize) ----------
function ResizeModal({ server, onClose, onDone }) {
  const [flavors, setFlavors] = useState([]);
  const [flavorRef, setFlavorRef] = useState('');
  const [busy, setBusy] = useState(false);
  const curId = server.flavor?.id;

  useEffect(() => {
    api('/flavors').then((d) => {
      const fl = d.flavors.filter((f) => f.id !== curId);
      setFlavors(fl);
      setFlavorRef(fl[0]?.id || '');
    }).catch((e) => toast(e.message, 'error'));
  }, [curId]);

  async function submit() {
    if (!flavorRef) return;
    setBusy(true);
    try {
      await api(`/servers/${server.id}/action`, { method: 'POST', body: { action: 'resize', flavorRef } });
      toast(`Đang resize ${server.name} — chờ trạng thái VERIFY_RESIZE rồi bấm "Xác nhận resize"`, 'ok');
      onDone();
    } catch (e) { toast(e.message, 'error'); setBusy(false); }
  }

  return (
    <Modal title={`Đổi cấu hình — ${server.name}`} onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Huỷ</button>
        <button className="btn primary" onClick={submit} disabled={busy || !flavorRef}>{busy ? 'Đang gửi…' : 'Resize'}</button></>}>
      <p className="dim">Hiện tại: <b>{server.flavor?.original_name || curId}</b>{server.flavor?.vcpus != null && ` — ${server.flavor.vcpus} vCPU / ${ramGB(server.flavor.ram)} / ${server.flavor.disk} GB`}</p>
      <Field label="Cấu hình mới">
        <select value={flavorRef} onChange={(e) => setFlavorRef(e.target.value)}>
          {flavors.map((f) => <option key={f.id} value={f.id}>{f.name} — {f.vcpus} vCPU / {ramGB(f.ram)} / {f.disk} GB</option>)}
        </select>
      </Field>
      <p className="warn-text">Máy sẽ tắt và di chuyển trong lúc resize. Sau khi lên VERIFY_RESIZE phải bấm "Xác nhận resize" (hoặc "Hoàn tác") trong menu hành động.</p>
    </Modal>
  );
}

// ---------- Log console ----------
function ConsoleLogModal({ server, onClose }) {
  const [log, setLog] = useState(null);

  async function load() {
    setLog(null);
    try {
      const d = await api(`/servers/${server.id}/console-log?lines=300`);
      setLog(d.output || '(log trống)');
    } catch (e) { setLog(`Không lấy được log: ${e.message}`); }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line

  return (
    <Modal title={`Log console — ${server.name}`} onClose={onClose} wide
      footer={<button className="btn ghost" onClick={load}>Tải lại log</button>}>
      {log === null ? <p>Đang tải log…</p> : <pre className="console-pre">{log}</pre>}
    </Modal>
  );
}

function FipModal({ server, onClose, onDone }) {
  const [fips, setFips] = useState(null);
  const [extNets, setExtNets] = useState([]);
  const [busy, setBusy] = useState(false);

  async function load() {
    const [f, e] = await Promise.all([api('/floatingips'), api('/external-networks')]);
    setFips(f.floatingips.filter((x) => !x.port_id));
    setExtNets(e.networks);
  }
  useEffect(() => { load().catch((e) => toast(e.message, 'error')); }, []);

  async function associate(fipId) {
    setBusy(true);
    try {
      await api(`/floatingips/${fipId}/associate`, { method: 'POST', body: { server_id: server.id } });
      toast(`Đã gắn Floating IP vào ${server.name}`, 'ok');
      onDone();
    } catch (e) { toast(e.message, 'error'); setBusy(false); }
  }

  async function allocateAndAssociate() {
    if (!extNets.length) return toast('Không có mạng external nào', 'error');
    setBusy(true);
    try {
      const d = await api('/floatingips', { method: 'POST', body: { floating_network_id: extNets[0].id } });
      await api(`/floatingips/${d.floatingip.id}/associate`, { method: 'POST', body: { server_id: server.id } });
      toast(`Đã cấp ${d.floatingip.floating_ip_address} cho ${server.name}`, 'ok');
      onDone();
    } catch (e) { toast(e.message, 'error'); setBusy(false); }
  }

  return (
    <Modal title={`Gắn Floating IP — ${server.name}`} onClose={onClose}
      footer={<button className="btn primary" onClick={allocateAndAssociate} disabled={busy}>Cấp IP mới & gắn luôn</button>}>
      {!fips ? <p>Đang tải…</p> : fips.length === 0 ? (
        <p className="dim">Không có Floating IP trống. Bấm “Cấp IP mới & gắn luôn” để lấy IP từ pool.</p>
      ) : (
        <table className="tbl">
          <thead><tr><th>IP trống</th><th /></tr></thead>
          <tbody>
            {fips.map((f) => (
              <tr key={f.id}>
                <td className="mono">{f.floating_ip_address}</td>
                <td><button className="btn sm" disabled={busy} onClick={() => associate(f.id)}>Gắn IP này</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

// ---------- Cài lại hệ điều hành ----------
function RebuildModal({ server, onClose, onDone }) {
  const [images, setImages] = useState([]);
  const [f, setF] = useState({ imageRef: '', confirm: '' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/images').then((d) => {
      const act = d.images.filter((i) => i.status === 'active');
      setImages(act);
      setF((x) => ({ ...x, imageRef: act[0]?.id || '' }));
    }).catch((e) => toast(e.message, 'error'));
  }, []);

  async function submit() {
    if (f.confirm !== server.name) return toast('Gõ đúng tên máy để xác nhận', 'error');
    setBusy(true);
    try {
      await api(`/servers/${server.id}/rebuild`, { method: 'POST', body: { imageRef: f.imageRef } });
      toast('Đang cài lại hệ điều hành…', 'ok');
      onDone();
    } catch (e) { toast(e.message, 'error'); setBusy(false); }
  }

  return (
    <Modal title={`Cài lại HĐH — ${server.name}`} onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Huỷ</button>
        <button className="btn primary" onClick={submit} disabled={busy || f.confirm !== server.name}>Cài lại</button></>}>
      <p className="warn-text">Toàn bộ dữ liệu trên đĩa gốc sẽ MẤT. Máy giữ nguyên IP, ID, security group và các volume gắn kèm.</p>
      <Field label="Image mới">
        <select value={f.imageRef} onChange={(e) => setF({ ...f, imageRef: e.target.value })}>
          {images.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
        </select>
      </Field>
      <Field label={`Gõ "${server.name}" để xác nhận`}>
        <input value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} placeholder={server.name} />
      </Field>
    </Modal>
  );
}

// ---------- Card mạng (NIC) ----------
function NicModal({ server, onClose, onDone }) {
  const [ifaces, setIfaces] = useState(null);
  const [nets, setNets] = useState([]);
  const [netId, setNetId] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    const [i, n] = await Promise.all([api(`/servers/${server.id}/interfaces`), api('/networks')]);
    setIfaces(i.interfaces);
    const inner = n.networks.filter((x) => !x['router:external']);
    setNets(inner);
    if (!netId && inner[0]) setNetId(inner[0].id);
  }
  useEffect(() => { load().catch((e) => toast(e.message, 'error')); }, []); // eslint-disable-line

  async function attach() {
    setBusy(true);
    try { await api(`/servers/${server.id}/interfaces`, { method: 'POST', body: { net_id: netId } }); toast('Đã gắn card mạng', 'ok'); await load(); onDone(); }
    catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  }
  async function detach(portId) {
    if (!window.confirm('Gỡ card mạng này khỏi máy?')) return;
    setBusy(true);
    try { await api(`/servers/${server.id}/interfaces/${portId}`, { method: 'DELETE' }); toast('Đã gỡ card mạng', 'ok'); await load(); onDone(); }
    catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  }

  const netName = (id) => nets.find((n) => n.id === id)?.name || id?.slice(0, 8);

  return (
    <Modal title={`Card mạng — ${server.name}`} onClose={onClose}>
      {!ifaces ? <p>Đang tải…</p> : (
        <>
          <table className="tbl">
            <thead><tr><th>Network</th><th>IP</th><th>Trạng thái</th><th /></tr></thead>
            <tbody>
              {ifaces.map((i) => (
                <tr key={i.port_id}>
                  <td>{netName(i.net_id)}</td>
                  <td className="mono">{i.fixed_ips?.map((x) => x.ip_address).join(', ')}</td>
                  <td><StatusBadge status={i.port_state} /></td>
                  <td><button className="btn sm danger-ghost" disabled={busy || ifaces.length <= 1} onClick={() => detach(i.port_id)}>Gỡ</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row-inline" style={{ marginTop: 12 }}>
            <select value={netId} onChange={(e) => setNetId(e.target.value)} style={{ flex: 1 }}>
              {nets.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
            </select>
            <button className="btn primary sm" onClick={attach} disabled={busy || !netId}>Gắn thêm</button>
          </div>
          <p className="dim">Card mạng mới cần cấu hình trong OS (netplan/NetworkManager) để lên IP; card cuối cùng không gỡ được.</p>
        </>
      )}
    </Modal>
  );
}

// ---------- Đổi security group của máy đang chạy ----------
function SgModal({ server, onClose, onDone }) {
  const [all, setAll] = useState([]);
  const [sel, setSel] = useState((server.security_groups || []).map((g) => g.name));
  const [busy, setBusy] = useState(false);
  const current = (server.security_groups || []).map((g) => g.name);

  useEffect(() => { api('/security-groups').then((d) => setAll(d.security_groups)).catch((e) => toast(e.message, 'error')); }, []);

  async function submit() {
    const add = sel.filter((n) => !current.includes(n));
    const remove = current.filter((n) => !sel.includes(n));
    if (!add.length && !remove.length) return onClose();
    setBusy(true);
    try {
      await api(`/servers/${server.id}/security-groups`, { method: 'POST', body: { add, remove } });
      toast('Đã cập nhật security group', 'ok');
      onDone();
    } catch (e) { toast(e.message, 'error'); setBusy(false); }
  }

  return (
    <Modal title={`Security group — ${server.name}`} onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Huỷ</button>
        <button className="btn primary" onClick={submit} disabled={busy}>Lưu</button></>}>
      <div className="check-list">
        {all.map((g) => (
          <label key={g.id} className="check-item">
            <input type="checkbox" checked={sel.includes(g.name)}
              onChange={() => setSel(sel.includes(g.name) ? sel.filter((x) => x !== g.name) : [...sel, g.name])} />
            <span>{g.name}</span><span className="dim">{g.description}</span>
          </label>
        ))}
      </div>
      <p className="dim">Thay đổi có hiệu lực ngay, không cần khởi động lại máy.</p>
    </Modal>
  );
}
