import React, { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { api } from '../api.js';
import { Modal, Field, StatusBadge, ActionsMenu, toast, Empty, PageHead } from '../components/ui.jsx';

export default function Networks() {
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
    if (!window.confirm(`Xoá network "${n.name}" và subnet của nó?`)) return;
    try { await api(`/networks/${n.id}`, { method: 'DELETE' }); toast('Đã xoá network', 'ok'); load(); }
    catch (e) { toast(e.message, 'error'); }
  }

  async function delRouter(r) {
    if (!window.confirm(`Xoá router "${r.name}"? (phải gỡ hết interface trước)`)) return;
    try { await api(`/routers/${r.id}`, { method: 'DELETE' }); toast('Đã xoá router', 'ok'); load(); }
    catch (e) { toast(e.message, 'error'); }
  }

  const extName = (id) => nets?.find((n) => n.id === id)?.name || id?.slice(0, 8);

  return (
    <>
      <PageHead title="Mạng & Router" count={nets?.length} onRefresh={load}>
        <button className="btn ghost" onClick={() => setCreatingRouter(true)}><Plus size={16} /> Tạo router</button>
        <button className="btn primary" onClick={() => setCreating(true)}><Plus size={16} /> Tạo network</button>
      </PageHead>

      {!nets ? <Empty>Đang tải…</Empty> : (
        <div className="card">
          <div className="card-head"><h4>Networks</h4></div>
          <table className="tbl">
            <thead><tr><th>Tên</th><th>Trạng thái</th><th>Subnet (CIDR)</th><th>Loại</th><th /></tr></thead>
            <tbody>
              {nets.map((n) => (
                <tr key={n.id}>
                  <td><b>{n.name}</b></td>
                  <td><StatusBadge status={n.status} /></td>
                  <td>{(n.subnet_details || []).map((s) => (
                    <span key={s.id} className="mono chip" title={`GW ${s.gateway_ip || '—'} · DHCP ${s.enable_dhcp ? 'bật' : 'tắt'}`}>{s.cidr}</span>
                  ))}</td>
                  <td className="dim">{n['router:external'] ? 'External' : n.shared ? 'Shared' : 'Nội bộ'}</td>
                  <td>{!n['router:external'] && (
                    <ActionsMenu items={[{ label: 'Xoá network', danger: true, onClick: () => delNet(n) }]} />
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <div className="card-head"><h4>Routers</h4></div>
        {routers.length === 0 ? <Empty>Chưa có router. Router kết nối network nội bộ ra mạng external.</Empty> : (
          <table className="tbl">
            <thead><tr><th>Tên</th><th>Trạng thái</th><th>Gateway external</th><th /></tr></thead>
            <tbody>
              {routers.map((r) => (
                <tr key={r.id}>
                  <td><b>{r.name}</b></td>
                  <td><StatusBadge status={r.status} /></td>
                  <td className="dim">{r.external_gateway_info ? extName(r.external_gateway_info.network_id) : '—'}</td>
                  <td>
                    <ActionsMenu items={[
                      { label: 'Quản lý interface', onClick: () => setIfaceFor(r) },
                      'divider',
                      { label: 'Xoá router', danger: true, onClick: () => delRouter(r) },
                    ]} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {creating && <CreateNetwork onClose={() => setCreating(false)} onDone={() => { setCreating(false); load(); }} />}
      {creatingRouter && <CreateRouter nets={nets || []} onClose={() => setCreatingRouter(false)} onDone={() => { setCreatingRouter(false); load(); }} />}
      {ifaceFor && <IfaceModal router={ifaceFor} nets={nets || []} onClose={() => setIfaceFor(null)} />}
    </>
  );
}

function CreateNetwork({ onClose, onDone }) {
  const [f, setF] = useState({ name: '', cidr: '10.0.0.0/24', gateway_ip: '', enable_dhcp: true, dns: '8.8.8.8' });
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!f.name.trim() || !f.cidr.trim()) return toast('Nhập tên và CIDR', 'error');
    setBusy(true);
    try {
      await api('/networks', { method: 'POST', body: f });
      toast(`Đã tạo network ${f.name}`, 'ok');
      onDone();
    } catch (e) { toast(e.message, 'error'); setBusy(false); }
  }

  return (
    <Modal title="Tạo network + subnet" onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Huỷ</button>
        <button className="btn primary" onClick={submit} disabled={busy}>{busy ? 'Đang tạo…' : 'Tạo network'}</button></>}>
      <Field label="Tên network"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="vd: net-app" autoFocus /></Field>
      <Field label="CIDR subnet"><input className="mono" value={f.cidr} onChange={(e) => setF({ ...f, cidr: e.target.value })} /></Field>
      <Field label="Gateway IP" hint="Bỏ trống để lấy IP đầu tiên của dải"><input className="mono" value={f.gateway_ip} onChange={(e) => setF({ ...f, gateway_ip: e.target.value })} placeholder="tự động" /></Field>
      <Field label="DNS" hint="Nhiều DNS cách nhau bằng dấu phẩy"><input className="mono" value={f.dns} onChange={(e) => setF({ ...f, dns: e.target.value })} /></Field>
      <label className="check-item"><input type="checkbox" checked={f.enable_dhcp} onChange={(e) => setF({ ...f, enable_dhcp: e.target.checked })} /> Bật DHCP</label>
    </Modal>
  );
}

function CreateRouter({ nets, onClose, onDone }) {
  const ext = nets.filter((n) => n['router:external']);
  const [f, setF] = useState({ name: '', external_network_id: ext[0]?.id || '' });
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!f.name.trim()) return toast('Nhập tên router', 'error');
    setBusy(true);
    try {
      await api('/routers', { method: 'POST', body: { name: f.name, external_network_id: f.external_network_id || undefined } });
      toast(`Đã tạo router ${f.name}`, 'ok');
      onDone();
    } catch (e) { toast(e.message, 'error'); setBusy(false); }
  }

  return (
    <Modal title="Tạo router" onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Huỷ</button>
        <button className="btn primary" onClick={submit} disabled={busy}>{busy ? 'Đang tạo…' : 'Tạo router'}</button></>}>
      <Field label="Tên router"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /></Field>
      <Field label="Gateway external" hint="Chọn mạng external để máy ảo ra Internet / dùng Floating IP">
        <select value={f.external_network_id} onChange={(e) => setF({ ...f, external_network_id: e.target.value })}>
          <option value="">— Không đặt —</option>
          {ext.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
        </select>
      </Field>
    </Modal>
  );
}

function IfaceModal({ router, nets, onClose }) {
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
    try { await api(`/routers/${router.id}/interfaces`, { method: 'POST', body: { subnet_id: subnetId } }); toast('Đã gắn subnet vào router', 'ok'); await load(); }
    catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  }

  async function remove(sid) {
    setBusy(true);
    try { await api(`/routers/${router.id}/interfaces/${sid}`, { method: 'DELETE' }); toast('Đã gỡ interface', 'ok'); await load(); }
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
          <option value="">— Chọn subnet để gắn —</option>
          {allSubnets.map((s) => <option key={s.id} value={s.id}>{s.netName} — {s.cidr}</option>)}
        </select>
        <button className="btn primary sm" onClick={add} disabled={busy || !subnetId}>Gắn</button>
      </div>
      {!ifaces ? <p>Đang tải…</p> : ifaces.length === 0 ? <p className="dim">Router chưa có interface nào.</p> : (
        <table className="tbl">
          <thead><tr><th>Subnet</th><th>IP</th><th /></tr></thead>
          <tbody>
            {ifaces.map((p) => (
              <tr key={p.id}>
                <td>{subnetLabel(p.fixed_ips?.[0]?.subnet_id)}</td>
                <td className="mono">{p.fixed_ips?.[0]?.ip_address}</td>
                <td><button className="btn sm danger-ghost" disabled={busy} onClick={() => remove(p.fixed_ips?.[0]?.subnet_id)}>Gỡ</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}
