import React, { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { api } from '../api.js';
import { Modal, Field, StatusBadge, ActionsMenu, toast, Empty, PageHead } from '../components/ui.jsx';
import { useI18n } from '../i18n/react.jsx';

export default function Networks() {
  const { t } = useI18n();
  const [nets, setNets] = useState(null);
  const [routers, setRouters] = useState([]);
  const [creating, setCreating] = useState(false);
  const [creatingRouter, setCreatingRouter] = useState(false);
  const [ifaceFor, setIfaceFor] = useState(null);

  async function load() {
    try {
      const [n, r] = await Promise.all([api('/networks'), api('/routers')]);
      setNets(n.networks); setRouters(r.routers);
    } catch (e) { toast(e.message, 'error'); }
  }
  useEffect(() => { load(); }, []);

  async function delNet(n) {
    if (!window.confirm(t('networks.deleteNetworkConfirm', { name: n.name }))) return;
    try { await api(`/networks/${n.id}`, { method: 'DELETE' }); toast(t('networks.networkDeleted'), 'ok'); load(); }
    catch (e) { toast(e.message, 'error'); }
  }

  async function delRouter(r) {
    if (!window.confirm(t('networks.deleteRouterConfirm', { name: r.name }))) return;
    try { await api(`/routers/${r.id}`, { method: 'DELETE' }); toast(t('networks.routerDeleted'), 'ok'); load(); }
    catch (e) { toast(e.message, 'error'); }
  }

  const extName = (id) => nets?.find((n) => n.id === id)?.name || id?.slice(0, 8);

  return (
    <>
      <PageHead title={t('navigation.networks')} count={nets?.length} onRefresh={load}>
        <button className="btn ghost" onClick={() => setCreatingRouter(true)}><Plus size={16} /> {t('networks.createRouter')}</button>
        <button className="btn primary" onClick={() => setCreating(true)}><Plus size={16} /> {t('networks.createNetwork')}</button>
      </PageHead>

      {!nets ? <Empty>{t('common.loading')}</Empty> : (
        <div className="card">
          <div className="card-head"><h4>Networks</h4></div>
          <table className="tbl">
            <thead><tr><th>{t('common.name')}</th><th>{t('common.status')}</th><th>Subnet (CIDR)</th><th>{t('networks.type')}</th><th /></tr></thead>
            <tbody>
              {nets.map((n) => (
                <tr key={n.id}>
                  <td><b>{n.name}</b></td>
                  <td><StatusBadge status={n.status} /></td>
                  <td>{(n.subnet_details || []).map((s) => (
                    <span key={s.id} className="mono chip" title={`GW ${s.gateway_ip || '—'} · DHCP ${t(s.enable_dhcp ? 'networks.on' : 'networks.off')}`}>{s.cidr}</span>
                  ))}</td>
                  <td className="dim">{t(n['router:external'] ? 'networks.external' : n.shared ? 'networks.shared' : 'networks.internal')}</td>
                  <td>{!n['router:external'] && (
                    <ActionsMenu items={[{ label: t('networks.deleteNetwork'), danger: true, onClick: () => delNet(n) }]} />
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <div className="card-head"><h4>Routers</h4></div>
        {routers.length === 0 ? <Empty>{t('networks.noRouters')}</Empty> : (
          <table className="tbl">
            <thead><tr><th>{t('common.name')}</th><th>{t('common.status')}</th><th>{t('networks.externalGateway')}</th><th /></tr></thead>
            <tbody>
              {routers.map((r) => (
                <tr key={r.id}>
                  <td><b>{r.name}</b></td>
                  <td><StatusBadge status={r.status} /></td>
                  <td className="dim">{r.external_gateway_info ? extName(r.external_gateway_info.network_id) : '—'}</td>
                  <td>
                    <ActionsMenu items={[
                      { label: t('networks.manageInterfaces'), onClick: () => setIfaceFor(r) },
                      'divider',
                      { label: t('networks.deleteRouter'), danger: true, onClick: () => delRouter(r) },
                    ]} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {creating && <CreateNetwork routers={routers} onClose={() => setCreating(false)} onDone={() => { setCreating(false); load(); }} />}
      {creatingRouter && <CreateRouter nets={nets || []} onClose={() => setCreatingRouter(false)} onDone={() => { setCreatingRouter(false); load(); }} />}
      {ifaceFor && <IfaceModal router={ifaceFor} nets={nets || []} onClose={() => setIfaceFor(null)} />}
    </>
  );
}

export function createNetworkValidationKey(form) {
  if (!form.name.trim() || !form.cidr.trim()) return 'networks.nameCidrRequired';
  if (form.mode === 'routed' && !form.router_id) return 'networks.create.routerRequired';
  return null;
}

export function createNetworkBody(form) {
  return {
    name: form.name, cidr: form.cidr, gateway_ip: form.gateway_ip, dns: form.dns, mode: form.mode,
    ...(form.mode === 'routed' ? { router_id: form.router_id } : {}),
  };
}

export async function runNetworkCreate(form, { request, notify, translate, onDone }) {
  await request('/networks', { method: 'POST', body: createNetworkBody(form) });
  notify(translate(form.mode === 'routed' ? 'networks.create.routedSuccess' : 'networks.create.isolatedSuccess'), 'ok');
  onDone();
}

export function CreateNetwork({ routers = [], onClose, onDone, initialMode = 'isolated' }) {
  const { t } = useI18n();
  const [f, setF] = useState({ name: '', cidr: '10.0.0.0/24', gateway_ip: '', dns: '8.8.8.8', mode: initialMode, router_id: '' });
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (busy) return;
    const validation = createNetworkValidationKey(f);
    if (validation) return toast(t(validation), 'error');
    setBusy(true);
    try {
      await runNetworkCreate(f, { request: api, notify: toast, translate: t, onDone });
    } catch (e) { toast(e.message, 'error'); setBusy(false); }
  }

  return (
    <Modal title={t('networks.createNetworkTitle')} onClose={() => { if (!busy) onClose(); }}
      footer={<><button className="btn ghost" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
        <button className="btn primary" onClick={submit} disabled={busy}>{t(busy ? 'instances.creating' : 'networks.createNetwork')}</button></>}>
      <Field label={t('networks.networkName')}><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. net-app" autoFocus /></Field>
      <Field label={t('networks.create.cidr')}><input className="mono" value={f.cidr} onChange={(e) => setF({ ...f, cidr: e.target.value })} /></Field>
      <fieldset className="network-mode-field">
        <legend className="field-label">{t('networks.create.mode')}</legend>
        <div className="network-mode-options">
          {['isolated', 'routed'].map((mode) => (
            <label key={mode} className={`network-mode-option${f.mode === mode ? ' selected' : ''}`}>
              <input type="radio" name="network-mode" value={mode} checked={f.mode === mode} onChange={() => setF({ ...f, mode, router_id: '' })} />
              <span>{t(mode === 'routed' ? 'networks.create.modeRouted' : 'networks.create.modeIsolated')}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <Field label={t('networks.create.gateway')} hint={f.mode === 'isolated' ? t('networks.create.isolatedGatewayHint') : t('networks.gatewayHint')}>
        <input className="mono" value={f.gateway_ip} onChange={(e) => setF({ ...f, gateway_ip: e.target.value })} placeholder={t('networks.automatic')} />
      </Field>
      {f.mode === 'routed' && <Field label={t('networks.create.router')}>
        <select value={f.router_id} required onChange={(e) => setF({ ...f, router_id: e.target.value })}>
          <option value="">— {t('networks.create.selectRouter')} —</option>
          {routers.map((router) => <option key={router.id} value={router.id}>{router.name}</option>)}
        </select>
      </Field>}
      <Field label={t('networks.create.dns')} hint={t('networks.dnsHint')}><input className="mono" value={f.dns} onChange={(e) => setF({ ...f, dns: e.target.value })} /></Field>
    </Modal>
  );
}

function CreateRouter({ nets, onClose, onDone }) {
  const { t } = useI18n();
  const ext = nets.filter((n) => n['router:external']);
  const [f, setF] = useState({ name: '', external_network_id: ext[0]?.id || '' });
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!f.name.trim()) return toast(t('networks.routerNameRequired'), 'error');
    setBusy(true);
    try {
      await api('/routers', { method: 'POST', body: { name: f.name, external_network_id: f.external_network_id || undefined } });
      toast(t('networks.routerCreated', { name: f.name }), 'ok');
      onDone();
    } catch (e) { toast(e.message, 'error'); setBusy(false); }
  }

  return (
    <Modal title={t('networks.createRouter')} onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn primary" onClick={submit} disabled={busy}>{t(busy ? 'instances.creating' : 'networks.createRouter')}</button></>}>
      <Field label={t('networks.routerName')}><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /></Field>
      <Field label={t('networks.externalGateway')} hint={t('networks.externalGatewayHint')}>
        <select value={f.external_network_id} onChange={(e) => setF({ ...f, external_network_id: e.target.value })}>
          <option value="">— {t('networks.notSet')} —</option>
          {ext.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
        </select>
      </Field>
    </Modal>
  );
}

function IfaceModal({ router, nets, onClose }) {
  const { t } = useI18n();
  const [ifaces, setIfaces] = useState(null);
  const [subnetId, setSubnetId] = useState('');
  const [busy, setBusy] = useState(false);

  const allSubnets = nets.filter((n) => !n['router:external']).flatMap((n) => (n.subnet_details || []).map((s) => ({ ...s, netName: n.name })));

  async function load() {
    const d = await api(`/routers/${router.id}/interfaces`);
    setIfaces(d.interfaces);
  }
  useEffect(() => { load().catch((e) => toast(e.message, 'error')); }, []); // eslint-disable-line

  async function add() {
    if (!subnetId) return;
    setBusy(true);
    try { await api(`/routers/${router.id}/interfaces`, { method: 'POST', body: { subnet_id: subnetId } }); toast(t('networks.subnetAttached'), 'ok'); await load(); }
    catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  }

  async function remove(sid) {
    setBusy(true);
    try { await api(`/routers/${router.id}/interfaces/${sid}`, { method: 'DELETE' }); toast(t('networks.interfaceDetached'), 'ok'); await load(); }
    catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  }

  const subnetLabel = (sid) => {
    const s = allSubnets.find((x) => x.id === sid);
    return s ? `${s.netName} — ${s.cidr}` : sid?.slice(0, 8);
  };

  return (
    <Modal title={`Interface — ${router.name}`} onClose={onClose}>
      <div className="row-inline" style={{ marginBottom: 14 }}>
        <select value={subnetId} onChange={(e) => setSubnetId(e.target.value)} style={{ flex: 1 }}>
          <option value="">— {t('networks.selectSubnet')} —</option>
          {allSubnets.map((s) => <option key={s.id} value={s.id}>{s.netName} — {s.cidr}</option>)}
        </select>
        <button className="btn primary sm" onClick={add} disabled={busy || !subnetId}>{t('networks.attach')}</button>
      </div>
      {!ifaces ? <p>{t('common.loading')}</p> : ifaces.length === 0 ? <p className="dim">{t('networks.noInterfaces')}</p> : (
        <table className="tbl">
          <thead><tr><th>Subnet</th><th>IP</th><th /></tr></thead>
          <tbody>
            {ifaces.map((p) => (
              <tr key={p.id}>
                <td>{subnetLabel(p.fixed_ips?.[0]?.subnet_id)}</td>
                <td className="mono">{p.fixed_ips?.[0]?.ip_address}</td>
                <td><button className="btn sm danger-ghost" disabled={busy} onClick={() => remove(p.fixed_ips?.[0]?.subnet_id)}>{t('instances.detach')}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}
