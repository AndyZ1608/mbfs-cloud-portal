import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api, fmtDate, ramGB, serverIps } from '../api.js';
import { Modal, Field, StatusBadge, ActionsMenu, toast, Empty, PageHead } from '../components/ui.jsx';
import MonitorModal from '../components/MonitorModal.jsx';
import TypeToConfirmDialog from '../components/TypeToConfirmDialog.jsx';
import { validResizeFlavor, submitResizeOnce } from '../resize.js';
import useInstanceActions from '../useInstanceActions.js';
import { useI18n } from '../i18n/react.jsx';
import NetworkInterfaceFields, { addInterface, newInterface, removeInterface, validInterfaces } from '../components/NetworkInterfaceFields.jsx';
import OsCatalog from '../components/OsCatalog.jsx';

export default function Instances() {
  const { t } = useI18n();
  const [servers, setServers] = useState(null);
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState('');
  const [monFor, setMonFor] = useState(null);
  const [monStatus, setMonStatus] = useState(null);
  const [latest, setLatest] = useState({});
  const timer = useRef(null);
  const actions = useInstanceActions({ onChanged: load });

  async function load() {
    try {
      const d = await api('/servers');
      setServers(d.servers);
      actions.syncServers(d.servers);
      api('/monitor/latest').then((m) => setLatest(m.latest || {})).catch(() => {});
    } catch (e) { toast(e.message, 'error'); }
  }

  useEffect(() => {
    load();
    api('/monitor/status').then(setMonStatus).catch(() => {});
    timer.current = setInterval(load, 10000);
    return () => { clearInterval(timer.current); };
  }, []);

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
                  <td><Link className="link-btn" to={`/instances/${encodeURIComponent(s.id)}`}>{s.name}</Link></td>
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
                    <ActionsMenu items={actions.items(s)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && <CreateModal onClose={() => setCreating(false)} onDone={() => { setCreating(false); load(); }} />}
      <InstanceActionDialogs actions={actions} />
      {monFor && <MonitorModal server={monFor} status={monStatus} onClose={() => setMonFor(null)} />}
    </>
  );
}

export function InstanceActionDialogs({ actions }) {
  const { t } = useI18n();
  const { kind, server } = actions.target;
  if (!server) return null;
  return <>
    {kind === 'password' && <ChangePasswordModal key={server.id} server={server}
      onClose={actions.close} onDone={() => actions.dialogDone()} />}
    {kind === 'fip' && <FipModal server={server} onClose={actions.close} onDone={() => actions.dialogDone()} />}
    {kind === 'resize' && <ResizeModal server={server} onClose={actions.close} onDone={() => {
      actions.setPendingResize((current) => new Map(current).set(server.id, server.status));
      actions.dialogDone();
    }} />}
    {kind === 'rebuild' && <RebuildModal server={server} onClose={actions.close} onDone={() => actions.dialogDone()} />}
    {kind === 'nic' && <NicModal server={server} onClose={actions.close} onDone={() => actions.dialogDone({ keepOpen: true })} />}
    {kind === 'sg' && <SgModal server={server} onClose={actions.close} onDone={() => actions.dialogDone()} />}
    {kind === 'delete' && <TypeToConfirmDialog title={t('instances.delete')}
      description={t('instances.deleteDescription')} resourceName={server.name} resourceId={server.id}
      confirmLabel={t('instances.delete')} loading={actions.deleting}
      onConfirm={actions.confirmDelete} onCancel={actions.closeDelete} />}
  </>;
}

// ---------- Tạo máy ảo ----------
function CreateModal({ onClose, onDone }) {
  const { t } = useI18n();
  const [opts, setOpts] = useState(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [f, setF] = useState({
    name: '', flavorRef: '', imageRef: '', interfaces: [newInterface()], key_name: '',
    count: 1, bfv: false, boot_volume_gb: 40,
    show_ud: false, user_data: '',
  });

  useEffect(() => {
    Promise.all([api('/flavors'), api('/images'), api('/available-networks'), api('/keypairs')])
      .then(([fl, im, ne, kp]) => {
        const nets = ne.networks.filter((n) => !n['router:external']);
        setOpts({
          flavors: fl.flavors,
          images: im.images.filter((i) => i.status === 'active'),
          networks: nets,
          keypairs: kp.keypairs,
        });
        setF((x) => ({
          ...x,
          flavorRef: fl.flavors[0]?.id || '',
          imageRef: '',
          interfaces: [newInterface(nets)],
          key_name: kp.keypairs[0]?.name || '',
        }));
      })
      .catch((e) => toast(e.message, 'error'));
  }, []);

  function updateInterface(index, value) {
    setF((current) => ({ ...current, interfaces: current.interfaces.map((item, at) => at === index ? value : item) }));
  }

  function close() {
    if (!submitting.current) onClose();
  }

  async function submit() {
    if (submitting.current) return;
    if (!f.name.trim()) return toast(t('instances.nameRequired'), 'error');
    if (!opts?.images.some((image) => image.id === f.imageRef)) return toast(t('instance.create.imageRequired'), 'error');
    if (!validInterfaces(f.interfaces, opts?.networks || [])) return toast(t('instance.networkInterfaces.required'), 'error');
    if (Number(f.count) > 1 && f.interfaces.some((item) => item.ip_address.trim())) return toast(t('errors.interface_batch_fixed_ip'), 'error');
    submitting.current = true;
    setBusy(true);
    try {
      await api('/servers', {
        method: 'POST',
        body: {
          name: f.name.trim(), flavorRef: f.flavorRef, imageRef: f.imageRef,
          interfaces: f.interfaces.map(({ network_id, subnet_id, ip_address }) => ({ network_id, subnet_id, ip_address: ip_address.trim() || null })),
          key_name: f.key_name || undefined, count: Number(f.count) || 1,
          boot_volume_gb: f.bfv ? Number(f.boot_volume_gb) : undefined,
          user_data: f.show_ud && f.user_data.trim() ? f.user_data : undefined,
        },
      });
      toast(t('instances.creatingName', { name: f.name }), 'ok');
      onDone();
    } catch (e) { toast(e.message, 'error'); } finally { submitting.current = false; setBusy(false); }
  }

  return (
    <Modal title={t('instances.createTitle')} onClose={close} wide
      footer={<>
        <button className="btn ghost" onClick={close} disabled={busy}>{t('common.cancel')}</button>
        <button className="btn primary" onClick={submit} disabled={busy || !opts || !f.imageRef}>{t(busy ? 'instances.creating' : 'instances.create')}</button>
      </>}>
      {!opts ? <p>{t('instances.loadingOptions')}</p> : (
        <div className="form-grid">
          <Field label={t('instances.vmName')}>
            <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="vd: web-portal-02" autoFocus />
          </Field>
          <Field label={t('instances.count')} hint={t('instances.countHint')}>
            <input type="number" min="1" max="10" value={f.count} onChange={(e) => setF({ ...f, count: e.target.value })} />
          </Field>
          <OsCatalog images={opts.images} selectedImageId={f.imageRef}
            onSelect={(imageRef) => setF((current) => ({ ...current, imageRef }))} disabled={busy} />
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
          <div className="vm-interface-section">
            <h3>{t('instance.networkInterfaces.title')}</h3>
            {f.interfaces.map((item, index) => <NetworkInterfaceFields key={index} index={index} value={item}
              networks={opts.networks} disabled={busy} onChange={(value) => updateInterface(index, value)}
              onRemove={index > 0 ? () => setF((current) => ({ ...current, interfaces: removeInterface(current.interfaces, index) })) : null} />)}
            {opts.networks.length === 0 && <p className="dim">{t('instances.noInternalNetwork')}</p>}
            <button className="btn ghost sm" type="button" disabled={busy || !opts.networks.length}
              onClick={() => setF((current) => ({ ...current, interfaces: addInterface(current.interfaces, opts.networks) }))}>
              <Plus size={14} /> {t('instance.networkInterfaces.add')}
            </button>
          </div>
          <Field label={t('instances.initScript')} hint={t('instances.initScriptHint')}>
            <label className="check-item" style={{ marginBottom: 6 }}>
              <input type="checkbox" checked={f.show_ud} onChange={(e) => setF({ ...f, show_ud: e.target.checked })} /> {t('instances.addScript')}
            </label>
            {f.show_ud && (
              <textarea className="mono" rows={6} value={f.user_data} onChange={(e) => setF({ ...f, user_data: e.target.value })}
                placeholder={t('instances.scriptPlaceholder')} />
            )}
          </Field>
        </div>
      )}
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
  const [groups, setGroups] = useState([]);
  const [nic, setNic] = useState(newInterface());
  const [busy, setBusy] = useState(false);
  const operationPending = useRef(false);

  async function load() {
    const [i, n, sg] = await Promise.all([api(`/servers/${server.id}/interfaces`), api('/available-networks'), api('/security-groups')]);
    setIfaces(i.interfaces);
    const inner = n.networks.filter((x) => !x['router:external']);
    setNets(inner);
    setGroups(sg.security_groups);
    setNic(newInterface(inner));
  }
  useEffect(() => { load().catch((e) => toast(e.message, 'error')); }, []); // eslint-disable-line

  async function attach() {
    if (operationPending.current || !validInterfaces([nic], nets)) return;
    operationPending.current = true;
    setBusy(true);
    try {
      await api(`/servers/${server.id}/interfaces`, { method: 'POST', body: {
        network_id: nic.network_id, subnet_id: nic.subnet_id, ip_address: nic.ip_address.trim() || null,
      } });
      toast(t('instances.nicAttached'), 'ok'); await load(); onDone();
    }
    catch (e) { toast(e.message, 'error'); }
    finally { operationPending.current = false; setBusy(false); }
  }
  async function detach(portId) {
    if (operationPending.current) return;
    if (!window.confirm(t('instances.nicDetachConfirm'))) return;
    operationPending.current = true;
    setBusy(true);
    try { await api(`/servers/${server.id}/interfaces/${portId}`, { method: 'DELETE' }); toast(t('instances.nicDetached'), 'ok'); await load(); onDone(); }
    catch (e) { toast(e.message, 'error'); }
    finally { operationPending.current = false; setBusy(false); }
  }

  const netName = (id) => nets.find((n) => n.id === id)?.name || id?.slice(0, 8);
  const subnetName = (id) => nets.flatMap((n) => n.subnet_details || []).find((subnet) => subnet.id === id)?.cidr || id?.slice(0, 8);
  const groupNames = (ids) => (ids || []).map((id) => groups.find((group) => group.id === id)?.name || id.slice(0, 8)).join(', ') || '—';

  return (
    <Modal title={t('instances.nicTitle', { name: server.name })} onClose={() => { if (!operationPending.current) onClose(); }} wide>
      {!ifaces ? <p>{t('common.loading')}</p> : (
        <>
          <div className="vm-interface-table"><table className="tbl">
            <thead><tr><th>{t('instance.networkInterfaces.network')}</th><th>{t('instance.networkInterfaces.subnet')}</th>
              <th>{t('instance.networkInterfaces.ipAddress')}</th><th>MAC</th><th>Port UUID</th>
              <th>{t('instance.networkInterfaces.securityGroup')}</th><th>{t('common.status')}</th><th /></tr></thead>
            <tbody>
              {ifaces.map((i) => (
                <tr key={i.id}>
                  <td>{netName(i.network_id)}</td>
                  <td>{i.fixed_ips?.map((x) => subnetName(x.subnet_id)).join(', ') || '—'}</td>
                  <td className="mono">{i.fixed_ips?.map((x) => x.ip_address).join(', ')}</td>
                  <td className="mono">{i.mac_address || '—'}</td>
                  <td className="mono">{i.id}</td>
                  <td>{groupNames(i.security_groups)}</td>
                  <td><StatusBadge status={i.status} /></td>
                  <td><button className="btn sm danger-ghost" disabled={busy || ifaces.length <= 1} onClick={() => detach(i.id)}>{t('instances.detach')}</button></td>
                </tr>
              ))}
            </tbody>
          </table></div>
          <div className="vm-interface-section" style={{ marginTop: 14 }}>
            <h3>{t('instance.networkInterfaces.addInterface')}</h3>
            <NetworkInterfaceFields value={nic} onChange={setNic} networks={nets} index={0} disabled={busy} />
            <button className="btn primary sm" onClick={attach} disabled={busy || !validInterfaces([nic], nets)}>{t('instance.networkInterfaces.add')}</button>
          </div>
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
