import React, { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { api, fmtDate, ramGB, serverIps } from '../api.js';
import { Modal, Field, StatusBadge, ActionsMenu, toast, Empty, PageHead } from '../components/ui.jsx';
import MonitorModal from '../components/MonitorModal.jsx';
import TypeToConfirmDialog from '../components/TypeToConfirmDialog.jsx';
import { openInstanceConsole } from '../console/navigation.js';
import { canStartResize, canFinalizeResize, validResizeFlavor, submitResizeOnce } from '../resize.js';
import { useI18n } from '../i18n/react.jsx';

export default function Instances() {
  const { t } = useI18n();
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
  const [passwordFor, setPasswordFor] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [pendingResize, setPendingResize] = useState(new Map());
  const deleteRequest = useRef(false);
  const actionRequests = useRef(new Set());
  const timer = useRef(null);

  async function load() {
    try {
      const d = await api('/servers');
      setServers(d.servers);
      setPendingResize((current) => {
        const next = new Map(current);
        for (const server of d.servers) {
          if (next.has(server.id) && next.get(server.id) !== server.status) next.delete(server.id);
        }
        return next.size === current.size ? current : next;
      });
      api('/monitor/latest').then((m) => setLatest(m.latest || {})).catch(() => {});
    } catch (e) { toast(e.message, 'error'); }
  }

  useEffect(() => {
    load();
    api('/monitor/status').then(setMonStatus).catch(() => {});
    timer.current = setInterval(load, 10000);
    return () => { clearInterval(timer.current); };
  }, []);

  async function act(s, action, label) {
    const finalizingResize = action === 'confirm-resize' || action === 'revert-resize';
    if (finalizingResize && (actionRequests.current.has(s.id) || pendingResize.has(s.id))) return;
    if (finalizingResize) {
      actionRequests.current.add(s.id);
      setPendingResize((current) => new Map(current).set(s.id, s.status));
    }
    try {
      await api(`/servers/${s.id}/action`, { method: 'POST', body: { action } });
      toast(t('instances.actionWithName', { action: label, name: s.name }), 'ok');
      if (finalizingResize) load();
      setTimeout(load, 800);
    } catch (e) {
      if (finalizingResize) setPendingResize((current) => { const next = new Map(current); next.delete(s.id); return next; });
      toast(e.message, 'error');
    } finally {
      if (finalizingResize) actionRequests.current.delete(s.id);
    }
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
      toast(t('instances.deleteSent', { name: s.name }), 'ok');
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
    const name = window.prompt(t('instances.renamePrompt'), s.name);
    if (!name || name.trim() === s.name) return;
    try {
      await api(`/servers/${s.id}`, { method: 'PUT', body: { name: name.trim() } });
      toast(t('instances.renamed', { name: name.trim() }), 'ok');
      load();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function snapshot(s) {
    const name = window.prompt(t('instances.snapshotPrompt'), `${s.name}-snap-${new Date().toISOString().slice(0, 10)}`);
    if (!name) return;
    try {
      await api(`/servers/${s.id}/action`, { method: 'POST', body: { action: 'snapshot', name } });
      toast(t('instances.snapshotStarted', { name }), 'ok');
    } catch (e) { toast(e.message, 'error'); }
  }
  const shown = !servers ? null : servers.filter((s) => {
    const t = q.trim().toLowerCase();
    if (!t) return true;
    return (s.name || '').toLowerCase().includes(t) || serverIps(s).some((x) => x.ip.includes(t));
  });

  return (
    <>
      <PageHead title={t('instances.title')} count={shown?.length} onRefresh={load}>
        <input placeholder={t('instances.search')} value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 190 }} />
        <button className="btn primary" onClick={() => setCreating(true)}><Plus size={16} /> {t('instances.create')}</button>
      </PageHead>

      {!servers ? <Empty>{t('common.loading')}</Empty> : shown.length === 0 ? (
        <Empty>{t('instances.empty')}</Empty>
      ) : (
        <div className="card">
          <table className="tbl">
            <thead><tr><th>{t('common.name')}</th><th>{t('common.status')}</th><th>CPU</th><th>{t('common.ipAddress')}</th><th>{t('instances.flavor')}</th><th>SSH key</th><th>{t('common.createdAt')}</th><th /></tr></thead>
            <tbody>
              {shown.map((s) => (
                <tr key={s.id}>
                  <td><button className="link-btn" onClick={() => setDetail(s)}>{s.name}</button></td>
                  <td><StatusBadge status={s.status} />{s['OS-EXT-STS:task_state'] && <span className="dim task"> {s['OS-EXT-STS:task_state']}…</span>}</td>
                  <td>{latest[s.id] ? (
                    <button className={`cpu-chip cpu-${latest[s.id].cpu >= 90 ? 'hot' : latest[s.id].cpu >= 70 ? 'warm' : 'ok'}`}
                      onClick={() => setMonFor(s)} title={t('instances.monitor')}>{latest[s.id].cpu}%</button>
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
                      canFinalizeResize(s, pendingResize.has(s.id)) && { label: t('instances.confirmResize'), onClick: () => act(s, 'confirm-resize', t('instances.confirmResizeSent')) },
                      canFinalizeResize(s, pendingResize.has(s.id)) && { label: t('instances.revertResize'), onClick: () => act(s, 'revert-resize', t('instances.revertResizeSent')) },
                      canFinalizeResize(s, pendingResize.has(s.id)) && 'divider',
                      !['ACTIVE', 'VERIFY_RESIZE', 'RESIZE', 'RESIZE_MIGRATING'].includes(s.status) && { label: t('instances.start'), onClick: () => act(s, 'start', t('instances.started')) },
                      s.status === 'ACTIVE' && { label: t('instances.stop'), onClick: () => act(s, 'stop', t('instances.stopSent')) },
                      s.status === 'ACTIVE' && { label: t('instances.softReboot'), onClick: () => act(s, 'reboot-soft', t('instances.rebooting')) },
                      s.status === 'ACTIVE' && { label: t('instances.hardReboot'), onClick: () => act(s, 'reboot-hard', t('instances.rebooting')) },
                      canStartResize(s, pendingResize.has(s.id)) && { label: t('instances.resize'), onClick: () => setResizeFor(s) },
                      { label: t('instances.rename'), onClick: () => rename(s) },
                      { label: t('instances.console'), onClick: () => openInstanceConsole(s.id) },
                      { label: t('instances.changePassword'), onClick: () => setPasswordFor(s) },
                      { label: t('instances.monitor'), onClick: () => setMonFor(s) },
                      { label: t('instances.consoleLog'), onClick: () => setLogFor(s) },
                      { label: t('instances.networkCards'), onClick: () => setNicFor(s) },
                      { label: t('instances.securityGroups'), onClick: () => setSgFor(s) },
                      (s.status === 'ACTIVE' || s.status === 'SHUTOFF') && { label: t('instances.rebuild'), onClick: () => setRebuildFor(s) },
                      s.status === 'ACTIVE' && { label: t('instances.shelve'), onClick: () => act(s, 'shelve', t('instances.shelving')) },
                      (s.status === 'SHELVED' || s.status === 'SHELVED_OFFLOADED') && { label: t('instances.unshelve'), onClick: () => act(s, 'unshelve', t('instances.unshelving')) },
                      { label: t('instances.snapshot'), onClick: () => snapshot(s) },
                      { label: t('instances.floatingIp'), onClick: () => setFipTarget(s) },
                      'divider',
                      { label: t('instances.delete'), danger: true, onClick: () => openDelete(s) },
                    ]} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && <CreateModal onClose={() => setCreating(false)} onDone={() => { setCreating(false); load(); }} />}
      {detail && <DetailModal server={detail} onClose={() => setDetail(null)}
        onChangePassword={() => { setPasswordFor(detail); setDetail(null); }} />}
      {passwordFor && <ChangePasswordModal key={passwordFor.id} server={passwordFor}
        onClose={() => setPasswordFor(null)} onDone={() => setPasswordFor(null)} />}
      {fipTarget && <FipModal server={fipTarget} onClose={() => setFipTarget(null)} onDone={() => { setFipTarget(null); load(); }} />}
      {resizeFor && <ResizeModal server={resizeFor} onClose={() => setResizeFor(null)} onDone={() => {
        setPendingResize((current) => new Map(current).set(resizeFor.id, resizeFor.status));
        setResizeFor(null);
        load();
        setTimeout(load, 800);
      }} />}
      {logFor && <ConsoleLogModal server={logFor} onClose={() => setLogFor(null)} />}
      {monFor && <MonitorModal server={monFor} status={monStatus} onClose={() => setMonFor(null)} />}
      {rebuildFor && <RebuildModal server={rebuildFor} onClose={() => setRebuildFor(null)} onDone={() => { setRebuildFor(null); setTimeout(load, 800); }} />}
      {nicFor && <NicModal server={nicFor} onClose={() => setNicFor(null)} onDone={load} />}
      {sgFor && <SgModal server={sgFor} onClose={() => setSgFor(null)} onDone={() => { setSgFor(null); load(); }} />}
      {deleteFor && <TypeToConfirmDialog
        title={t('instances.delete')}
        description={t('instances.deleteDescription')}
        resourceName={deleteFor.name}
        resourceId={deleteFor.id}
        confirmLabel={t('instances.delete')}
        loading={deleting}
        onConfirm={confirmDelete}
        onCancel={closeDelete}
      />}
    </>
  );
}

// ---------- Tạo máy ảo ----------
function CreateModal({ onClose, onDone }) {
  const { t } = useI18n();
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
    if (!f.name.trim()) return toast(t('instances.nameRequired'), 'error');
    if (!f.networks.length) return toast(t('instances.networkRequired'), 'error');
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
      toast(t('instances.creatingName', { name: f.name }), 'ok');
      onDone();
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  }

  return (
    <Modal title={t('instances.createTitle')} onClose={onClose} wide
      footer={<>
        <button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn primary" onClick={submit} disabled={busy || !opts}>{t(busy ? 'instances.creating' : 'instances.create')}</button>
      </>}>
      {!opts ? <p>{t('instances.loadingOptions')}</p> : (
        <div className="form-grid">
          <Field label={t('instances.vmName')}>
            <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="vd: web-portal-02" autoFocus />
          </Field>
          <Field label={t('instances.count')} hint={t('instances.countHint')}>
            <input type="number" min="1" max="10" value={f.count} onChange={(e) => setF({ ...f, count: e.target.value })} />
          </Field>
          <Field label={t('instances.image')}>
            <select value={f.imageRef} onChange={(e) => setF({ ...f, imageRef: e.target.value })}>
              {opts.images.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select>
          </Field>
          <Field label={t('instances.flavor')}>
            <select value={f.flavorRef} onChange={(e) => setF({ ...f, flavorRef: e.target.value })}>
              {opts.flavors.map((x) => <option key={x.id} value={x.id}>{x.name} — {x.vcpus} vCPU / {ramGB(x.ram)} / {x.disk} GB</option>)}
            </select>
          </Field>
          <Field label="SSH key">
            <select value={f.key_name} onChange={(e) => setF({ ...f, key_name: e.target.value })}>
              <option value="">— {t('instances.none')} —</option>
              {opts.keypairs.map((k) => <option key={k.name} value={k.name}>{k.name}</option>)}
            </select>
          </Field>
          <Field label={t('instances.bootFromVolume')} hint={t('instances.bootFromVolumeHint')}>
            <div className="row-inline">
              <input type="checkbox" checked={f.bfv} onChange={(e) => setF({ ...f, bfv: e.target.checked })} id="bfv" />
              <label htmlFor="bfv">{t('instances.enable')}</label>
              {f.bfv && <><input type="number" min="10" style={{ width: 90 }} value={f.boot_volume_gb}
                onChange={(e) => setF({ ...f, boot_volume_gb: e.target.value })} /> <span className="dim">GB</span></>}
            </div>
          </Field>
          <Field label={t('instances.networkSelection')}>
            <div className="check-list">
              {opts.networks.map((n) => (
                <label key={n.id} className="check-item">
                  <input type="checkbox" checked={f.networks.includes(n.id)} onChange={() => setF({ ...f, networks: toggle(f.networks, n.id) })} />
                  <span>{n.name}</span>
                  <span className="mono dim">{n.subnet_details?.map((s) => s.cidr).join(', ')}</span>
                </label>
              ))}
              {opts.networks.length === 0 && <p className="dim">{t('instances.noInternalNetwork')}</p>}
            </div>
          </Field>
          <Field label={t('instances.initScript')} hint={t('instances.initScriptHint')}>
            <label className="check-item" style={{ marginBottom: 6 }}>
              <input type="checkbox" checked={f.show_ud} onChange={(e) => setF({ ...f, show_ud: e.target.checked })} /> {t('instances.addScript')}
            </label>
            {f.show_ud && (
              <textarea className="mono" rows={6} value={f.user_data} onChange={(e) => setF({ ...f, user_data: e.target.value })}
                placeholder={t('instances.scriptPlaceholder')} />
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
function DetailModal({ server, onClose, onChangePassword }) {
  const { t } = useI18n();
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
    <Modal title={s.name} onClose={onClose}
      footer={<button className="btn ghost" type="button" onClick={onChangePassword}>{t('instances.changePassword')}</button>}>
      <div className="kv">
        <div><span>ID</span><span className="mono">{s.id}</span></div>
        <div><span>{t('common.status')}</span><span><StatusBadge status={s.status} /></span></div>
        <div><span>{t('instances.flavor')}</span><span>{s.flavor?.original_name || s.flavor?.id} {s.flavor?.vcpus != null && `· ${s.flavor.vcpus} vCPU / ${ramGB(s.flavor.ram)} / ${s.flavor.disk} GB`}</span></div>
        <div><span>{t('common.ipAddress')}</span><span>{serverIps(s).map((x) => <span key={x.ip} className="mono chip">{x.ip} <em className="dim">({x.type})</em></span>)}</span></div>
        <div><span>Security group</span><span>{(s.security_groups || []).map((g) => g.name).join(', ') || '—'}</span></div>
        <div><span>SSH key</span><span>{s.key_name || '—'}</span></div>
        <div><span>{t('instances.attachedVolumes')}</span><span>{attached.length ? attached.join(', ') : '—'}</span></div>
        <div><span>Availability zone</span><span>{s['OS-EXT-AZ:availability_zone'] || '—'}</span></div>
        <div><span>{t('common.createdAt')}</span><span>{fmtDate(s.created)}</span></div>
        {s.fault?.message && <div><span>{t('instances.fault')}</span><span className="err-text">{s.fault.message}</span></div>}
      </div>
    </Modal>
  );
}

function ChangePasswordModal({ server, onClose, onDone }) {
  const { t } = useI18n();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submitted = useRef(false);

  function close() {
    if (submitted.current) return;
    setPassword('');
    setConfirmation('');
    onClose();
  }

  async function submit(event) {
    event.preventDefault();
    if (submitted.current || !password || password !== confirmation) return;
    submitted.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await api(`/servers/${encodeURIComponent(server.id)}/change-password`, {
        method: 'POST', body: { password },
      });
      if (result?.success !== true) throw new Error(t('instances.passwordUnconfirmed'));
      toast(t('instances.passwordAccepted'), 'ok');
      onDone();
    } catch (failure) {
      setError(failure.message || t('instances.passwordFailure'));
    } finally {
      setPassword('');
      setConfirmation('');
      submitted.current = false;
      setBusy(false);
    }
  }

  return (
    <Modal title={t('instances.changePasswordTitle')} onClose={close}>
      <form onSubmit={submit}>
        <div className="kv">
          <div><span>VM</span><strong>{server.name}</strong></div>
        </div>
        <Field label={t('instances.newPassword')}>
          <input type="password" autoComplete="off" value={password}
            onChange={(event) => setPassword(event.target.value)} disabled={busy} />
        </Field>
        <Field label={t('instances.confirmPassword')}>
          <input type="password" autoComplete="off" value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)} disabled={busy} />
        </Field>
        {confirmation && password !== confirmation && <p className="err-text" role="alert">{t('instances.passwordMismatch')}</p>}
        {error && <p className="err-text" role="alert">{error}</p>}
        <div className="modal-foot password-modal-actions">
          <button className="btn ghost" type="button" onClick={close} disabled={busy}>{t('common.cancel')}</button>
          <button className="btn primary" type="submit" disabled={busy || !password || password !== confirmation}>
            {t(busy ? 'instances.loadingRequest' : 'instances.changePassword')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---------- Đổi cấu hình (resize) ----------
function ResizeModal({ server, onClose, onDone }) {
  const { t } = useI18n();
  const [flavors, setFlavors] = useState([]);
  const [flavorRef, setFlavorRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const requestPending = useRef(false);
  const curId = server.flavor?.id;

  useEffect(() => {
    api('/flavors').then((d) => {
      const fl = d.flavors.filter((f) => f.id !== curId);
      setFlavors(fl);
      setFlavorRef(fl[0]?.id || '');
    }).catch((e) => toast(e.message, 'error'));
  }, [curId]);

  function close() {
    if (!requestPending.current) onClose();
  }

  async function submit() {
    await submitResizeOnce({
      pending: requestPending, server, flavorRef, currentFlavorId: curId, flavors, request: api,
      onStart: () => { setBusy(true); setError(''); },
      onAccepted: () => {
        setFlavorRef('');
        toast(t('instances.resizeWaiting', { name: server.name }), 'ok');
        onDone();
      },
      onError: (failure) => { setError(failure.message || t('instances.resizeFailed')); setBusy(false); },
    });
  }

  return (
    <Modal title={t('instances.resizeTitle', { name: server.name })} onClose={close}
      footer={<><button className="btn ghost" onClick={close} disabled={busy}>{t('common.cancel')}</button>
        <button className="btn primary" onClick={submit} disabled={busy || !validResizeFlavor(flavorRef, curId, flavors)}>{t(busy ? 'instances.loadingRequest' : 'instances.resizeSubmit')}</button></>}>
      <p className="dim">{t('instances.currentFlavor')}: <b>{server.flavor?.original_name || curId}</b>{server.flavor?.vcpus != null && ` — ${server.flavor.vcpus} vCPU / ${ramGB(server.flavor.ram)} / ${server.flavor.disk} GB`}</p>
      <Field label={t('instances.newFlavor')}>
        <select value={flavorRef} onChange={(e) => setFlavorRef(e.target.value)} disabled={busy}>
          {flavors.map((f) => <option key={f.id} value={f.id}>{f.name} — {f.vcpus} vCPU / {ramGB(f.ram)} / {f.disk} GB</option>)}
        </select>
      </Field>
      {error && <p className="err-text" role="alert">{error}</p>}
      <p className="warn-text">{t('instances.resizeWarning')}</p>
    </Modal>
  );
}

// ---------- Log console ----------
function ConsoleLogModal({ server, onClose }) {
  const { t } = useI18n();
  const [log, setLog] = useState(null);

  async function load() {
    setLog(null);
    try {
      const d = await api(`/servers/${server.id}/console-log?lines=300`);
      setLog(d.output || t('instances.logEmpty'));
    } catch (e) { setLog(t('instances.logFailed', { message: e.message })); }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line

  return (
    <Modal title={t('instances.logTitle', { name: server.name })} onClose={onClose} wide
      footer={<button className="btn ghost" onClick={load}>{t('instances.reloadLog')}</button>}>
      {log === null ? <p>{t('instances.loadingLog')}</p> : <pre className="console-pre">{log}</pre>}
    </Modal>
  );
}

function FipModal({ server, onClose, onDone }) {
  const { t } = useI18n();
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
      toast(t('instances.fipAttached', { name: server.name }), 'ok');
      onDone();
    } catch (e) { toast(e.message, 'error'); setBusy(false); }
  }

  async function allocateAndAssociate() {
    if (!extNets.length) return toast(t('instances.noExternalNetwork'), 'error');
    setBusy(true);
    try {
      const d = await api('/floatingips', { method: 'POST', body: { floating_network_id: extNets[0].id } });
      await api(`/floatingips/${d.floatingip.id}/associate`, { method: 'POST', body: { server_id: server.id } });
      toast(t('instances.fipAllocated', { ip: d.floatingip.floating_ip_address, name: server.name }), 'ok');
      onDone();
    } catch (e) { toast(e.message, 'error'); setBusy(false); }
  }

  return (
    <Modal title={t('instances.fipTitle', { name: server.name })} onClose={onClose}
      footer={<button className="btn primary" onClick={allocateAndAssociate} disabled={busy}>{t('instances.allocateAndAttach')}</button>}>
      {!fips ? <p>{t('common.loading')}</p> : fips.length === 0 ? (
        <p className="dim">{t('instances.noAvailableFip')}</p>
      ) : (
        <table className="tbl">
          <thead><tr><th>{t('instances.availableIp')}</th><th /></tr></thead>
          <tbody>
            {fips.map((f) => (
              <tr key={f.id}>
                <td className="mono">{f.floating_ip_address}</td>
                <td><button className="btn sm" disabled={busy} onClick={() => associate(f.id)}>{t('instances.attachThisIp')}</button></td>
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
  const { t } = useI18n();
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
    if (f.confirm !== server.name) return toast(t('instances.rebuildConfirmRequired'), 'error');
    setBusy(true);
    try {
      await api(`/servers/${server.id}/rebuild`, { method: 'POST', body: { imageRef: f.imageRef } });
      toast(t('instances.rebuilding'), 'ok');
      onDone();
    } catch (e) { toast(e.message, 'error'); setBusy(false); }
  }

  return (
    <Modal title={t('instances.rebuildTitle', { name: server.name })} onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn primary" onClick={submit} disabled={busy || f.confirm !== server.name}>{t('instances.rebuildSubmit')}</button></>}>
      <p className="warn-text">{t('instances.rebuildWarning')}</p>
      <Field label={t('instances.newImage')}>
        <select value={f.imageRef} onChange={(e) => setF({ ...f, imageRef: e.target.value })}>
          {images.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
        </select>
      </Field>
      <Field label={t('instances.rebuildTypeName', { name: server.name })}>
        <input value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} placeholder={server.name} />
      </Field>
    </Modal>
  );
}

// ---------- Card mạng (NIC) ----------
function NicModal({ server, onClose, onDone }) {
  const { t } = useI18n();
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
    try { await api(`/servers/${server.id}/interfaces`, { method: 'POST', body: { net_id: netId } }); toast(t('instances.nicAttached'), 'ok'); await load(); onDone(); }
    catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  }
  async function detach(portId) {
    if (!window.confirm(t('instances.nicDetachConfirm'))) return;
    setBusy(true);
    try { await api(`/servers/${server.id}/interfaces/${portId}`, { method: 'DELETE' }); toast(t('instances.nicDetached'), 'ok'); await load(); onDone(); }
    catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  }

  const netName = (id) => nets.find((n) => n.id === id)?.name || id?.slice(0, 8);

  return (
    <Modal title={t('instances.nicTitle', { name: server.name })} onClose={onClose}>
      {!ifaces ? <p>{t('common.loading')}</p> : (
        <>
          <table className="tbl">
            <thead><tr><th>Network</th><th>IP</th><th>{t('common.status')}</th><th /></tr></thead>
            <tbody>
              {ifaces.map((i) => (
                <tr key={i.port_id}>
                  <td>{netName(i.net_id)}</td>
                  <td className="mono">{i.fixed_ips?.map((x) => x.ip_address).join(', ')}</td>
                  <td><StatusBadge status={i.port_state} /></td>
                  <td><button className="btn sm danger-ghost" disabled={busy || ifaces.length <= 1} onClick={() => detach(i.port_id)}>{t('instances.detach')}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row-inline" style={{ marginTop: 12 }}>
            <select value={netId} onChange={(e) => setNetId(e.target.value)} style={{ flex: 1 }}>
              {nets.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
            </select>
            <button className="btn primary sm" onClick={attach} disabled={busy || !netId}>{t('instances.attachMore')}</button>
          </div>
          <p className="dim">{t('instances.nicHint')}</p>
        </>
      )}
    </Modal>
  );
}

// ---------- Đổi security group của máy đang chạy ----------
function SgModal({ server, onClose, onDone }) {
  const { t } = useI18n();
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
      toast(t('instances.sgUpdated'), 'ok');
      onDone();
    } catch (e) { toast(e.message, 'error'); setBusy(false); }
  }

  return (
    <Modal title={`Security group — ${server.name}`} onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn primary" onClick={submit} disabled={busy}>{t('common.save')}</button></>}>
      <div className="check-list">
        {all.map((g) => (
          <label key={g.id} className="check-item">
            <input type="checkbox" checked={sel.includes(g.name)}
              onChange={() => setSel(sel.includes(g.name) ? sel.filter((x) => x !== g.name) : [...sel, g.name])} />
            <span>{g.name}</span><span className="dim">{g.description}</span>
          </label>
        ))}
      </div>
      <p className="dim">{t('instances.sgHint')}</p>
    </Modal>
  );
}
