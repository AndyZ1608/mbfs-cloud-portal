import React, { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { api, fmtDate } from '../api.js';
import { Modal, Field, StatusBadge, ActionsMenu, toast, Empty, PageHead } from '../components/ui.jsx';
import { useI18n } from '../i18n/react.jsx';

export default function LoadBalancers() {
  const { t } = useI18n();
  const [available, setAvailable] = useState(null);
  const [lbs, setLbs] = useState(null);
  const [fips, setFips] = useState([]);
  const [creating, setCreating] = useState(false);
  const [detailFor, setDetailFor] = useState(null);
  const [fipFor, setFipFor] = useState(null);
  const timer = useRef(null);

  async function load() {
    try {
      const [l, f] = await Promise.all([api('/lb'), api('/floatingips')]);
      setLbs(l.loadbalancers); setFips(f.floatingips);
    } catch (e) { toast(e.message, 'error'); }
  }

  useEffect(() => {
    api('/lb/available').then((d) => {
      setAvailable(d.available);
      if (d.available) { load(); timer.current = setInterval(load, 10000); }
    }).catch(() => setAvailable(false));
    return () => clearInterval(timer.current);
  }, []); // eslint-disable-line

  async function del(lb) {
    if (!window.confirm(t('loadBalancers.deleteConfirm', { name: lb.name }))) return;
    try { await api(`/lb/${lb.id}`, { method: 'DELETE' }); toast(t('loadBalancers.deleting'), 'ok'); setTimeout(load, 800); }
    catch (e) { toast(e.message, 'error'); }
  }

  const fipOf = (lb) => fips.find((f) => f.fixed_ip_address === lb.vip_address && f.port_id);

  if (available === null) return <Empty>{t('loadBalancers.checking')}</Empty>;
  if (available === false) return (
    <>
      <PageHead title="Load Balancer" />
      <Empty>
        {t('loadBalancers.unavailable')} <b>Octavia</b> (<span className="mono">load-balancer</span>).<br />
        {t('objectStorage.checkController')} <span className="mono">openstack service list | grep -i octavia</span>
      </Empty>
    </>
  );

  return (
    <>
      <PageHead title="Load Balancer" count={lbs?.length} onRefresh={load}>
        <button className="btn primary" onClick={() => setCreating(true)}><Plus size={16} /> {t('loadBalancers.create')}</button>
      </PageHead>

      {!lbs ? <Empty>{t('common.loading')}</Empty> : lbs.length === 0 ? (
        <Empty>{t('loadBalancers.empty')}</Empty>
      ) : (
        <div className="card">
          <table className="tbl">
            <thead><tr><th>{t('common.name')}</th><th>Provisioning</th><th>{t('loadBalancers.operating')}</th><th>VIP</th><th>Floating IP</th><th>{t('common.createdAt')}</th><th /></tr></thead>
            <tbody>
              {lbs.map((lb) => {
                const f = fipOf(lb);
                return (
                  <tr key={lb.id}>
                    <td><button className="link-btn" onClick={() => setDetailFor(lb)}>{lb.name}</button></td>
                    <td><StatusBadge status={lb.provisioning_status} /></td>
                    <td><StatusBadge status={lb.operating_status} /></td>
                    <td><span className="mono chip">{lb.vip_address}</span></td>
                    <td>{f ? <span className="mono chip chip-fip">{f.floating_ip_address}</span> : <span className="dim">—</span>}</td>
                    <td className="dim">{fmtDate(lb.created_at)}</td>
                    <td>
                      <ActionsMenu items={[
                        { label: t('loadBalancers.details'), onClick: () => setDetailFor(lb) },
                        !f && { label: t('instances.floatingIp'), onClick: () => setFipFor(lb), disabled: lb.provisioning_status !== 'ACTIVE' },
                        'divider',
                        { label: t('loadBalancers.delete'), danger: true, onClick: () => del(lb) },
                      ]} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {creating && <CreateLbModal onClose={() => setCreating(false)} onDone={() => { setCreating(false); setTimeout(load, 800); }} />}
      {detailFor && <LbDetailModal lb={detailFor} onClose={() => setDetailFor(null)} />}
      {fipFor && <LbFipModal lb={fipFor} onClose={() => setFipFor(null)} onDone={() => { setFipFor(null); load(); }} />}
    </>
  );
}

// ---------- Tạo LB (fully-populated: listener + pool + members + monitor trong 1 call) ----------
function CreateLbModal({ onClose, onDone }) {
  const { t } = useI18n();
  const [opts, setOpts] = useState(null);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({
    name: '', subnet_id: '', protocol: 'HTTP', port: 80, algorithm: 'ROUND_ROBIN',
    member_port: 80, members: [], monitor: true, hm_path: '/', hm_delay: 5, hm_timeout: 5, hm_retries: 3,
  });

  useEffect(() => {
    Promise.all([api('/networks'), api('/servers')]).then(([n, s]) => {
      const subs = n.networks.filter((x) => !x['router:external'])
        .flatMap((x) => (x.subnet_details || []).map((sb) => ({ ...sb, netName: x.name })));
      setOpts({ subnets: subs, servers: s.servers });
      setF((x) => ({ ...x, subnet_id: subs[0]?.id || '' }));
    }).catch((e) => toast(e.message, 'error'));
  }, []);

  const toggleMember = (id) => setF((x) => ({ ...x, members: x.members.includes(id) ? x.members.filter((m) => m !== id) : [...x.members, id] }));

  async function submit() {
    if (!f.name.trim()) return toast(t('loadBalancers.nameRequired'), 'error');
    if (!f.members.length) return toast(t('loadBalancers.memberRequired'), 'error');
    setBusy(true);
    try {
      await api('/lb', {
        method: 'POST',
        body: {
          name: f.name.trim(), subnet_id: f.subnet_id, protocol: f.protocol, port: Number(f.port),
          algorithm: f.algorithm,
          members: f.members.map((id) => ({ server_id: id, port: Number(f.member_port) })),
          monitor: f.monitor ? { enabled: true, path: f.hm_path, delay: f.hm_delay, timeout: f.hm_timeout, retries: f.hm_retries } : { enabled: false },
        },
      });
      toast(t('loadBalancers.creatingName', { name: f.name }), 'ok');
      onDone();
    } catch (e) { toast(e.message, 'error'); setBusy(false); }
  }

  return (
    <Modal title={t('loadBalancers.create')} onClose={onClose} wide
      footer={<><button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn primary" onClick={submit} disabled={busy || !opts}>{t(busy ? 'instances.creating' : 'loadBalancers.create')}</button></>}>
      {!opts ? <p>{t('common.loading')}</p> : (
        <div className="form-grid">
          <Field label={t('loadBalancers.lbName')}><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. lb-web-app" autoFocus /></Field>
          <Field label={t('loadBalancers.vipSubnet')} hint={t('loadBalancers.vipHint')}>
            <select value={f.subnet_id} onChange={(e) => setF({ ...f, subnet_id: e.target.value })}>
              {opts.subnets.map((s) => <option key={s.id} value={s.id}>{s.netName} — {s.cidr}</option>)}
            </select>
          </Field>
          <Field label={t('securityGroups.protocol')} hint={f.protocol === 'HTTPS' ? t('loadBalancers.httpsHint') : undefined}>
            <select value={f.protocol} onChange={(e) => { const pr = e.target.value; setF({ ...f, protocol: pr, port: pr === 'HTTPS' ? 443 : pr === 'HTTP' ? 80 : f.port, member_port: pr === 'HTTPS' ? 443 : pr === 'HTTP' ? 80 : f.member_port }); }}>
              <option value="HTTP">HTTP</option>
              <option value="HTTPS">HTTPS (passthrough)</option>
              <option value="TCP">TCP</option>
            </select>
          </Field>
          <Field label={t('loadBalancers.listenerPort')}><input type="number" min="1" max="65535" className="mono" value={f.port} onChange={(e) => setF({ ...f, port: e.target.value })} /></Field>
          <Field label={t('loadBalancers.algorithm')}>
            <select value={f.algorithm} onChange={(e) => setF({ ...f, algorithm: e.target.value })}>
              <option value="ROUND_ROBIN">Round robin</option>
              <option value="LEAST_CONNECTIONS">Least connections</option>
              <option value="SOURCE_IP">Source IP (sticky)</option>
            </select>
          </Field>
          <Field label={t('loadBalancers.backendPort')} hint={t('loadBalancers.backendPortHint')}><input type="number" min="1" max="65535" className="mono" value={f.member_port} onChange={(e) => setF({ ...f, member_port: e.target.value })} /></Field>
          <Field label={t('loadBalancers.backendInstances')}>
            <div className="check-list">
              {opts.servers.map((s) => (
                <label key={s.id} className="check-item">
                  <input type="checkbox" checked={f.members.includes(s.id)} onChange={() => toggleMember(s.id)} />
                  <span>{s.name}</span><span className="dim">({s.status})</span>
                </label>
              ))}
              {opts.servers.length === 0 && <p className="dim">{t('dashboard.noInstances')}</p>}
            </div>
          </Field>
          <Field label="Health monitor">
            <label className="check-item"><input type="checkbox" checked={f.monitor} onChange={(e) => setF({ ...f, monitor: e.target.checked })} /> {t('loadBalancers.enableMonitor')}</label>
            {f.monitor && (
              <div className="row-inline" style={{ marginTop: 8, flexWrap: 'wrap' }}>
                {f.protocol === 'HTTP' && <span className="row-inline"><span className="dim">Path</span><input className="mono" style={{ width: 90 }} value={f.hm_path} onChange={(e) => setF({ ...f, hm_path: e.target.value })} /></span>}
                <span className="row-inline"><span className="dim">Delay</span><input type="number" style={{ width: 62 }} value={f.hm_delay} onChange={(e) => setF({ ...f, hm_delay: e.target.value })} /></span>
                <span className="row-inline"><span className="dim">Timeout</span><input type="number" style={{ width: 62 }} value={f.hm_timeout} onChange={(e) => setF({ ...f, hm_timeout: e.target.value })} /></span>
                <span className="row-inline"><span className="dim">Retries</span><input type="number" style={{ width: 62 }} value={f.hm_retries} onChange={(e) => setF({ ...f, hm_retries: e.target.value })} /></span>
              </div>
            )}
          </Field>
        </div>
      )}
    </Modal>
  );
}

// ---------- Chi tiết LB: cây listener → pool → members ----------
function LbDetailModal({ lb, onClose }) {
  const { t } = useI18n();
  const [tree, setTree] = useState(null);
  const [servers, setServers] = useState([]);
  const [addSid, setAddSid] = useState('');
  const [addPort, setAddPort] = useState(80);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const [t, s] = await Promise.all([api(`/lb/${lb.id}/tree`), api('/servers')]);
      setTree(t); setServers(s.servers);
      if (!addSid && s.servers[0]) setAddSid(s.servers[0].id);
    } catch (e) { toast(e.message, 'error'); }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line

  const pool = tree?.listeners?.[0]?.pool;

  async function addMember() {
    if (!pool || !addSid) return;
    setBusy(true);
    try {
      await api(`/lb/pools/${pool.id}/members`, { method: 'POST', body: { server_id: addSid, port: Number(addPort) } });
      toast(t('loadBalancers.backendAdded'), 'ok');
      await load();
    } catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  }

  async function delMember(m) {
    if (!window.confirm(t('loadBalancers.removeBackendConfirm', { address: `${m.address}:${m.protocol_port}` }))) return;
    setBusy(true);
    try { await api(`/lb/pools/${pool.id}/members/${m.id}`, { method: 'DELETE' }); toast(t('loadBalancers.backendRemoved'), 'ok'); await load(); }
    catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  }

  const serverName = (addr) => servers.find((s) => JSON.stringify(s.addresses || {}).includes(`"${addr}"`))?.name;

  return (
    <Modal title={t('loadBalancers.detailTitle', { name: lb.name })} onClose={onClose} wide>
      {!tree ? <p>{t('common.loading')}</p> : (
        <>
          <div className="kv" style={{ marginBottom: 14 }}>
            <div><span>VIP</span><span className="mono">{tree.loadbalancer.vip_address}</span></div>
            <div><span>{t('common.status')}</span><span><StatusBadge status={tree.loadbalancer.provisioning_status} /> <StatusBadge status={tree.loadbalancer.operating_status} /></span></div>
            <div><span>Provider</span><span className="dim">{tree.loadbalancer.provider || '—'}</span></div>
          </div>
          {tree.listeners.map((ls) => (
            <div key={ls.id} className="lb-node">
              <div className="lb-node-head">
                <b>Listener</b> <span className="mono chip">{ls.protocol}:{ls.protocol_port}</span> <StatusBadge status={ls.operating_status} />
              </div>
              {ls.pool ? (
                <div className="lb-pool">
                  <div className="lb-node-head">
                    <b>Pool</b> <span className="dim">{ls.pool.lb_algorithm}</span>
                    {ls.pool.healthmonitor
                      ? <span className="dim">· monitor {ls.pool.healthmonitor.type}{ls.pool.healthmonitor.url_path ? ` ${ls.pool.healthmonitor.url_path}` : ''} ({t('loadBalancers.everySeconds', { seconds: ls.pool.healthmonitor.delay })})</span>
                      : <span className="dim">· {t('loadBalancers.noMonitor')}</span>}
                  </div>
                  <table className="tbl">
                    <thead><tr><th>Backend</th><th>{t('loadBalancers.address')}</th><th>{t('common.status')}</th><th /></tr></thead>
                    <tbody>
                      {ls.pool.members.map((m) => (
                        <tr key={m.id}>
                          <td>{m.name || serverName(m.address) || <span className="dim">—</span>}</td>
                          <td className="mono">{m.address}:{m.protocol_port}</td>
                          <td><StatusBadge status={m.operating_status} /></td>
                          <td><button className="btn sm danger-ghost" disabled={busy} onClick={() => delMember(m)}>{t('instances.detach')}</button></td>
                        </tr>
                      ))}
                      {ls.pool.members.length === 0 && <tr><td colSpan="4" className="dim">{t('loadBalancers.noBackends')}</td></tr>}
                    </tbody>
                  </table>
                  <div className="row-inline" style={{ marginTop: 10 }}>
                    <select value={addSid} onChange={(e) => setAddSid(e.target.value)} style={{ flex: 1 }}>
                      {servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                    <input type="number" className="mono" style={{ width: 84 }} value={addPort} onChange={(e) => setAddPort(e.target.value)} />
                    <button className="btn sm primary" disabled={busy || !addSid} onClick={addMember}>{t('loadBalancers.addBackend')}</button>
                  </div>
                </div>
              ) : <p className="dim">{t('loadBalancers.noPool')}</p>}
            </div>
          ))}
        </>
      )}
    </Modal>
  );
}

// ---------- Gắn Floating IP vào VIP ----------
function LbFipModal({ lb, onClose, onDone }) {
  const { t } = useI18n();
  const [fips, setFips] = useState(null);
  const [extNets, setExtNets] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([api('/floatingips'), api('/external-networks')]).then(([f, e]) => {
      setFips(f.floatingips.filter((x) => !x.port_id));
      setExtNets(e.networks);
    }).catch((e) => toast(e.message, 'error'));
  }, []);

  async function associate(fipId) {
    setBusy(true);
    try {
      await api(`/floatingips/${fipId}/associate`, { method: 'POST', body: { port_id: lb.vip_port_id } });
      toast(t('instances.fipAttached', { name: lb.name }), 'ok');
      onDone();
    } catch (e) { toast(e.message, 'error'); setBusy(false); }
  }

  async function allocateAndAssociate() {
    if (!extNets.length) return toast(t('instances.noExternalNetwork'), 'error');
    setBusy(true);
    try {
      const d = await api('/floatingips', { method: 'POST', body: { floating_network_id: extNets[0].id } });
      await api(`/floatingips/${d.floatingip.id}/associate`, { method: 'POST', body: { port_id: lb.vip_port_id } });
      toast(t('instances.fipAllocated', { ip: d.floatingip.floating_ip_address, name: lb.name }), 'ok');
      onDone();
    } catch (e) { toast(e.message, 'error'); setBusy(false); }
  }

  return (
    <Modal title={t('instances.fipTitle', { name: lb.name })} onClose={onClose}
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
