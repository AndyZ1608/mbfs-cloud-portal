import React, { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { api, fmtDate, ramGB } from '../api.js';
import { Modal, Field, StatusBadge, ActionsMenu, toast, Empty, PageHead } from '../components/ui.jsx';
import { useI18n } from '../i18n/react.jsx';

export default function K8sClusters() {
  const { t } = useI18n();
  const [clusters, setClusters] = useState(null);
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState(null);
  const timer = useRef(null);

  async function load() {
    try { setClusters((await api('/k8s/clusters')).clusters); }
    catch (e) { toast(e.message, 'error'); }
  }
  useEffect(() => {
    load();
    timer.current = setInterval(load, 12000);
    return () => clearInterval(timer.current);
  }, []);

  async function del(c) {
    if (!window.confirm(t('k8s.deleteConfirm', { name: c.name, count: c.nodes.length }))) return;
    try {
      const r = await api(`/k8s/clusters/${c.id}`, { method: 'DELETE' });
      toast(t(r.warnings?.length ? 'k8s.deletedWithWarnings' : 'k8s.deleted'), 'ok');
      r.warnings?.forEach((w) => toast(w, 'error'));
      load();
    } catch (e) { toast(e.message, 'error'); }
  }

  return (
    <>
      <PageHead title={t('k8s.title')} count={clusters?.length} onRefresh={load}>
        <button className="btn primary" onClick={() => setCreating(true)}><Plus size={16} /> {t('k8s.create')}</button>
      </PageHead>
      <p className="dim page-desc">{t('k8s.description')}</p>

      {!clusters ? <Empty>{t('common.loading')}</Empty> : clusters.length === 0 ? (
        <Empty>{t('k8s.empty')}</Empty>
      ) : (
        <div className="card">
          <table className="tbl">
            <thead><tr><th>{t('common.name')}</th><th>{t('k8s.readyNodes')}</th><th>Server IP</th><th>Floating IP</th><th>{t('common.createdAt')}</th><th /></tr></thead>
            <tbody>
              {clusters.map((c) => (
                <tr key={c.id}>
                  <td><button className="link-btn" onClick={() => setDetail(c)}>{c.name}</button></td>
                  <td><span className={`badge ${c.ready === c.nodes.length ? 'badge-ok' : 'badge-warn'}`}><i />{c.ready}/{c.nodes.length}</span></td>
                  <td><span className="mono chip">{c.server_ip}</span></td>
                  <td>{c.fip ? <span className="mono chip chip-fip">{c.fip}</span> : <span className="dim">—</span>}</td>
                  <td className="dim">{fmtDate(c.created_at)}</td>
                  <td>
                    <ActionsMenu items={[
                      { label: t('k8s.details'), onClick: () => setDetail(c) },
                      'divider',
                      { label: t('k8s.delete'), danger: true, onClick: () => del(c) },
                    ]} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && <CreateCluster onClose={() => setCreating(false)} onDone={() => { setCreating(false); load(); }} />}
      {detail && <ClusterDetail cluster={detail} onClose={() => setDetail(null)} />}
    </>
  );
}

function CreateCluster({ onClose, onDone }) {
  const { t } = useI18n();
  const [opts, setOpts] = useState(null);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ name: '', workers: 2, flavorRef: '', imageRef: '', network_id: '', key_name: '', admin_cidr: '0.0.0.0/0', assign_fip: true });

  useEffect(() => {
    Promise.all([api('/flavors'), api('/images'), api('/networks'), api('/keypairs')]).then(([fl, im, ne, kp]) => {
      const fits = fl.flavors.filter((x) => x.vcpus >= 2 && x.ram >= 4096);
      const flavors = fits.length ? fits : fl.flavors;
      const images = im.images.filter((i) => i.status === 'active');
      const ubuntu = images.find((i) => /ubuntu/i.test(i.name || ''));
      const nets = ne.networks.filter((n) => !n['router:external']);
      setOpts({ flavors, images, nets, keypairs: kp.keypairs, fitted: fits.length > 0 });
      setF((x) => ({ ...x, flavorRef: flavors[0]?.id || '', imageRef: (ubuntu || images[0])?.id || '', network_id: nets[0]?.id || '', key_name: kp.keypairs[0]?.name || '' }));
    }).catch((e) => toast(e.message, 'error'));
  }, []);

  async function submit() {
    if (!f.name.trim()) return toast(t('k8s.nameRequired'), 'error');
    if (!f.key_name) return toast(t('k8s.keyRequired'), 'error');
    setBusy(true);
    try {
      const r = await api('/k8s/deploy', { method: 'POST', body: { ...f, workers: Number(f.workers) } });
      toast(t('k8s.deploying', { name: f.name, count: 1 + Number(f.workers) }), 'ok');
      r.warnings?.forEach((w) => toast(w, 'error'));
      onDone();
    } catch (e) { toast(e.message, 'error'); setBusy(false); }
  }

  return (
    <Modal title={t('k8s.createTitle')} onClose={onClose} wide
      footer={<><button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn primary" onClick={submit} disabled={busy || !opts}>{t(busy ? 'k8s.deployingWait' : 'k8s.create')}</button></>}>
      {!opts ? <p>{t('common.loading')}</p> : (
        <div className="form-grid">
          <Field label={t('k8s.clusterName')} hint={t('k8s.nameHint')}><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. k8s-staging" autoFocus /></Field>
          <Field label={t('k8s.workerCount')} hint={t('k8s.workerHint')}><input type="number" min="0" max="9" value={f.workers} onChange={(e) => setF({ ...f, workers: e.target.value })} /></Field>
          <Field label={t('k8s.nodeFlavor')} hint={t(opts.fitted ? 'k8s.minimumFlavor' : 'k8s.noSuitableFlavor')}>
            <select value={f.flavorRef} onChange={(e) => setF({ ...f, flavorRef: e.target.value })}>
              {opts.flavors.map((x) => <option key={x.id} value={x.id}>{x.name} — {x.vcpus} vCPU / {ramGB(x.ram)} / {x.disk} GB</option>)}
            </select>
          </Field>
          <Field label="Image" hint="Ubuntu 22.04/24.04 cloud">
            <select value={f.imageRef} onChange={(e) => setF({ ...f, imageRef: e.target.value })}>
              {opts.images.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select>
          </Field>
          <Field label="Network">
            <select value={f.network_id} onChange={(e) => setF({ ...f, network_id: e.target.value })}>
              {opts.nets.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
            </select>
          </Field>
          <Field label={t('k8s.requiredKey')}>
            <select value={f.key_name} onChange={(e) => setF({ ...f, key_name: e.target.value })}>
              <option value="">— {t('k8s.selectKey')} —</option>
              {opts.keypairs.map((k) => <option key={k.name} value={k.name}>{k.name}</option>)}
            </select>
          </Field>
          <Field label={t('k8s.adminCidr')} hint={t('k8s.adminCidrHint')}>
            <input className="mono" value={f.admin_cidr} onChange={(e) => setF({ ...f, admin_cidr: e.target.value })} />
          </Field>
          <Field label="Floating IP">
            <label className="check-item"><input type="checkbox" checked={f.assign_fip} onChange={(e) => setF({ ...f, assign_fip: e.target.checked })} /> {t('k8s.assignFip')}</label>
          </Field>
        </div>
      )}
    </Modal>
  );
}

function ClusterDetail({ cluster, onClose }) {
  const { t } = useI18n();
  const [tok, setTok] = useState(null);
  const ip = cluster.fip || cluster.server_ip;

  async function revealToken() {
    try { setTok((await api(`/k8s/clusters/${cluster.id}/token`)).token); }
    catch (e) { toast(e.message, 'error'); }
  }

  return (
    <Modal title={`Cluster ${cluster.name}`} onClose={onClose} wide>
      <table className="tbl" style={{ marginBottom: 14 }}>
        <thead><tr><th>Node</th><th>{t('k8s.role')}</th><th>{t('k8s.vmStatus')}</th></tr></thead>
        <tbody>
          {cluster.nodes.map((n) => (
            <tr key={n.id}><td><b>{n.name}</b></td><td className="dim">{n.role}</td><td><StatusBadge status={n.status} /></td></tr>
          ))}
        </tbody>
      </table>
      <p className="mk-section">{t('k8s.getKubeconfig')}</p>
      <pre className="console-pre">{`ssh ubuntu@${ip} "sudo cat /etc/rancher/rke2/rke2.yaml" > ${cluster.name}.yaml
# ${t('k8s.replaceAddress')}: 127.0.0.1 → ${ip}
export KUBECONFIG=./${cluster.name}.yaml && kubectl get nodes`}</pre>
      <p className="dim">{t('k8s.readyHint', { count: cluster.nodes.length })} <span className="mono">kubectl get nodes</span>. Debug: <span className="mono">journalctl -u rke2-server -f</span>.</p>
      <p className="mk-section">{t('k8s.addNodeLater')}</p>
      {tok
        ? <p className="mono wrap">token: {tok}</p>
        : <button className="btn sm" onClick={revealToken}>{t('k8s.showJoinToken')}</button>}
    </Modal>
  );
}
