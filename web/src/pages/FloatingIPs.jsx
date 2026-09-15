import React, { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { api } from '../api.js';
import { Modal, Field, StatusBadge, ActionsMenu, toast, Empty, PageHead } from '../components/ui.jsx';

export default function FloatingIPs() {
  const [fips, setFips] = useState(null);
  const [allocating, setAllocating] = useState(false);
  const [assocFor, setAssocFor] = useState(null);

  async function load() {
    try { setFips((await api('/floatingips')).floatingips); }
    catch (e) { toast(e.message, 'error'); }
  }
  useEffect(() => { load(); }, []);

  async function disassociate(f) {
    if (!window.confirm(`Gỡ ${f.floating_ip_address} khỏi ${f.instance_name || 'máy ảo'}?`)) return;
    try { await api(`/floatingips/${f.id}/disassociate`, { method: 'POST' }); toast('Đã gỡ Floating IP', 'ok'); load(); }
    catch (e) { toast(e.message, 'error'); }
  }

  async function release(f) {
    if (!window.confirm(`Trả IP ${f.floating_ip_address} về pool? IP có thể được cấp cho project khác.`)) return;
    try { await api(`/floatingips/${f.id}`, { method: 'DELETE' }); toast('Đã trả IP về pool', 'ok'); load(); }
    catch (e) { toast(e.message, 'error'); }
  }

  return (
    <>
      <PageHead title="Floating IP" count={fips?.length} onRefresh={load}>
        <button className="btn primary" onClick={() => setAllocating(true)}><Plus size={16} /> Cấp IP mới</button>
      </PageHead>

      {!fips ? <Empty>Đang tải…</Empty> : fips.length === 0 ? (
        <Empty>Project chưa có Floating IP nào. Bấm “Cấp IP mới” để lấy IP từ pool external.</Empty>
      ) : (
        <div className="card">
          <table className="tbl">
            <thead><tr><th>Địa chỉ IP</th><th>Trạng thái</th><th>Gắn vào máy ảo</th><th>IP nội bộ</th><th /></tr></thead>
            <tbody>
              {fips.map((f) => (
                <tr key={f.id}>
                  <td className="mono"><b>{f.floating_ip_address}</b></td>
                  <td><StatusBadge status={f.status} /></td>
                  <td>{f.instance_name || <span className="dim">—</span>}</td>
                  <td className="mono dim">{f.fixed_ip_address || '—'}</td>
                  <td>
                    <ActionsMenu items={[
                      !f.port_id && { label: 'Gắn vào máy ảo', onClick: () => setAssocFor(f) },
                      f.port_id && { label: 'Gỡ khỏi máy ảo', onClick: () => disassociate(f) },
                      'divider',
                      { label: 'Trả IP về pool', danger: true, disabled: !!f.port_id, onClick: () => release(f) },
                    ]} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {allocating && <AllocateModal onClose={() => setAllocating(false)} onDone={() => { setAllocating(false); load(); }} />}
      {assocFor && <AssociateModal fip={assocFor} onClose={() => setAssocFor(null)} onDone={() => { setAssocFor(null); load(); }} />}
    </>
  );
}

function AllocateModal({ onClose, onDone }) {
  const [nets, setNets] = useState([]);
  const [netId, setNetId] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/external-networks').then((d) => { setNets(d.networks); setNetId(d.networks[0]?.id || ''); }).catch((e) => toast(e.message, 'error'));
  }, []);

  async function submit() {
    setBusy(true);
    try {
      const d = await api('/floatingips', { method: 'POST', body: { floating_network_id: netId } });
      toast(`Đã cấp IP ${d.floatingip.floating_ip_address}`, 'ok');
      onDone();
    } catch (e) { toast(e.message, 'error'); setBusy(false); }
  }

  return (
    <Modal title="Cấp Floating IP mới" onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Huỷ</button>
        <button className="btn primary" onClick={submit} disabled={busy || !netId}>Cấp IP</button></>}>
      <Field label="Pool (mạng external)">
        <select value={netId} onChange={(e) => setNetId(e.target.value)}>
          {nets.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
        </select>
      </Field>
    </Modal>
  );
}

function AssociateModal({ fip, onClose, onDone }) {
  const [servers, setServers] = useState([]);
  const [sid, setSid] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/servers').then((d) => { setServers(d.servers); setSid(d.servers[0]?.id || ''); }).catch((e) => toast(e.message, 'error'));
  }, []);

  async function submit() {
    setBusy(true);
    try {
      await api(`/floatingips/${fip.id}/associate`, { method: 'POST', body: { server_id: sid } });
      toast('Đã gắn Floating IP', 'ok');
      onDone();
    } catch (e) { toast(e.message, 'error'); setBusy(false); }
  }

  return (
    <Modal title={`Gắn ${fip.floating_ip_address} vào máy ảo`} onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Huỷ</button>
        <button className="btn primary" onClick={submit} disabled={busy || !sid}>Gắn IP</button></>}>
      <Field label="Chọn máy ảo">
        <select value={sid} onChange={(e) => setSid(e.target.value)}>
          {servers.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.status})</option>)}
        </select>
      </Field>
      <p className="dim">Máy ảo cần nằm trong subnet đã gắn vào router có gateway external.</p>
    </Modal>
  );
}
