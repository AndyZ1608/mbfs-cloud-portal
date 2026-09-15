import React, { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { api, fmtDate, ramGB } from '../api.js';
import { Modal, Field, StatusBadge, ActionsMenu, toast, Empty, PageHead } from '../components/ui.jsx';

export default function K8sClusters() {
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
    if (!window.confirm(`Xoá cluster "${c.name}" gồm ${c.nodes.length} máy ảo + security group? Dữ liệu trong cluster sẽ mất.`)) return;
    try {
      const r = await api(`/k8s/clusters/${c.id}`, { method: 'DELETE' });
      toast('Đã xoá cluster' + (r.warnings?.length ? ' (có cảnh báo)' : ''), 'ok');
      r.warnings?.forEach((w) => toast(w, 'error'));
      load();
    } catch (e) { toast(e.message, 'error'); }
  }

  return (
    <>
      <PageHead title="Kubernetes (RKE2)" count={clusters?.length} onRefresh={load}>
        <button className="btn primary" onClick={() => setCreating(true)}><Plus size={16} /> Tạo cluster</button>
      </PageHead>
      <p className="dim page-desc">Dựng cụm RKE2 tự động: 1 server + N worker, tự mở firewall nội bộ cụm và cổng quản trị. RKE2 cài 5–10 phút mỗi node sau khi VM ACTIVE (tải từ get.rke2.io).</p>

      {!clusters ? <Empty>Đang tải…</Empty> : clusters.length === 0 ? (
        <Empty>Chưa có cluster nào. Đây chính là cách team dựng nhanh môi trường RKE2 test/staging.</Empty>
      ) : (
        <div className="card">
          <table className="tbl">
            <thead><tr><th>Tên</th><th>Node sẵn sàng</th><th>Server IP</th><th>Floating IP</th><th>Tạo lúc</th><th /></tr></thead>
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
                      { label: 'Chi tiết / Kubeconfig', onClick: () => setDetail(c) },
                      'divider',
                      { label: 'Xoá cluster', danger: true, onClick: () => del(c) },
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
    if (!f.name.trim()) return toast('Nhập tên cluster', 'error');
    if (!f.key_name) return toast('Bắt buộc chọn SSH key để lấy kubeconfig', 'error');
    setBusy(true);
    try {
      const r = await api('/k8s/deploy', { method: 'POST', body: { ...f, workers: Number(f.workers) } });
      toast(`Đang dựng cluster ${f.name} (${1 + Number(f.workers)} node)`, 'ok');
      r.warnings?.forEach((w) => toast(w, 'error'));
      onDone();
    } catch (e) { toast(e.message, 'error'); setBusy(false); }
  }

  return (
    <Modal title="Tạo cluster RKE2" onClose={onClose} wide
      footer={<><button className="btn ghost" onClick={onClose}>Huỷ</button>
        <button className="btn primary" onClick={submit} disabled={busy || !opts}>{busy ? 'Đang dựng (chờ IP server node)…' : 'Tạo cluster'}</button></>}>
      {!opts ? <p>Đang tải…</p> : (
        <div className="form-grid">
          <Field label="Tên cluster" hint="chữ thường, số, gạch ngang"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="vd: k8s-staging" autoFocus /></Field>
          <Field label="Số worker (0–9)" hint="Tổng node = 1 server + N worker"><input type="number" min="0" max="9" value={f.workers} onChange={(e) => setF({ ...f, workers: e.target.value })} /></Field>
          <Field label="Cấu hình node" hint={opts.fitted ? 'RKE2 cần tối thiểu 2 vCPU / 4 GB' : 'Không flavor nào đạt 2 vCPU/4GB — hiển thị tất cả'}>
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
          <Field label="SSH key (bắt buộc)">
            <select value={f.key_name} onChange={(e) => setF({ ...f, key_name: e.target.value })}>
              <option value="">— Chọn key —</option>
              {opts.keypairs.map((k) => <option key={k.name} value={k.name}>{k.name}</option>)}
            </select>
          </Field>
          <Field label="CIDR quản trị" hint="Được phép truy cập kube-api 6443, 9345, SSH 22">
            <input className="mono" value={f.admin_cidr} onChange={(e) => setF({ ...f, admin_cidr: e.target.value })} />
          </Field>
          <Field label="Floating IP">
            <label className="check-item"><input type="checkbox" checked={f.assign_fip} onChange={(e) => setF({ ...f, assign_fip: e.target.checked })} /> Gắn Floating IP vào server node</label>
          </Field>
        </div>
      )}
    </Modal>
  );
}

function ClusterDetail({ cluster, onClose }) {
  const [tok, setTok] = useState(null);
  const ip = cluster.fip || cluster.server_ip;

  async function revealToken() {
    try { setTok((await api(`/k8s/clusters/${cluster.id}/token`)).token); }
    catch (e) { toast(e.message, 'error'); }
  }

  return (
    <Modal title={`Cluster ${cluster.name}`} onClose={onClose} wide>
      <table className="tbl" style={{ marginBottom: 14 }}>
        <thead><tr><th>Node</th><th>Vai trò</th><th>Trạng thái VM</th></tr></thead>
        <tbody>
          {cluster.nodes.map((n) => (
            <tr key={n.id}><td><b>{n.name}</b></td><td className="dim">{n.role}</td><td><StatusBadge status={n.status} /></td></tr>
          ))}
        </tbody>
      </table>
      <p className="mk-section">Lấy kubeconfig</p>
      <pre className="console-pre">{`ssh ubuntu@${ip} "sudo cat /etc/rancher/rke2/rke2.yaml" > ${cluster.name}.yaml
# sửa trong file: 127.0.0.1 → ${ip}
export KUBECONFIG=./${cluster.name}.yaml && kubectl get nodes`}</pre>
      <p className="dim">Trạng thái VM ACTIVE ≠ RKE2 đã cài xong — chờ 5–10 phút/node rồi <span className="mono">kubectl get nodes</span> phải thấy đủ {cluster.nodes.length} node Ready. Debug: <span className="mono">journalctl -u rke2-server -f</span> trên node.</p>
      <p className="mk-section">Thêm node thủ công sau này</p>
      {tok
        ? <p className="mono wrap">token: {tok}</p>
        : <button className="btn sm" onClick={revealToken}>Hiện token join</button>}
    </Modal>
  );
}
