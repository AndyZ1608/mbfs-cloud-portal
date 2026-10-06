import React, { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { api } from '../api.js';
import { Modal, Field, StatusBadge, ActionsMenu, toast, Empty, PageHead } from '../components/ui.jsx';
import { useI18n } from '../i18n/react.jsx';

export default function FloatingIPs() {
  const { t } = useI18n();
  const [fips, setFips] = useState(null);
  const [allocating, setAllocating] = useState(false);
  const [assocFor, setAssocFor] = useState(null);

  async function load() {
    try { setFips((await api('/floatingips')).floatingips); }
    catch (e) { toast(e.message, 'error'); }
  }
  useEffect(() => { load(); }, []);

  async function disassociate(f) {
    if (!window.confirm(t('floatingIps.disassociateConfirm', { ip: f.floating_ip_address, name: f.instance_name || t('instances.vmName') }))) return;
    try { await api(`/floatingips/${f.id}/disassociate`, { method: 'POST' }); toast(t('floatingIps.disassociated'), 'ok'); load(); }
    catch (e) { toast(e.message, 'error'); }
  }

  async function release(f) {
    if (!window.confirm(t('floatingIps.releaseConfirm', { ip: f.floating_ip_address }))) return;
    try { await api(`/floatingips/${f.id}`, { method: 'DELETE' }); toast(t('floatingIps.released'), 'ok'); load(); }
    catch (e) { toast(e.message, 'error'); }
  }

  return (
    <>
      <PageHead title={t('navigation.floatingIps')} count={fips?.length} onRefresh={load}>
        <button className="btn primary" onClick={() => setAllocating(true)}><Plus size={16} /> {t('floatingIps.allocate')}</button>
      </PageHead>

      {!fips ? <Empty>{t('common.loading')}</Empty> : fips.length === 0 ? (
        <Empty>{t('floatingIps.empty')}</Empty>
      ) : (
        <div className="card">
          <table className="tbl">
            <thead><tr><th>{t('common.ipAddress')}</th><th>{t('common.status')}</th><th>{t('floatingIps.associatedWith')}</th><th>{t('floatingIps.fixedIp')}</th><th /></tr></thead>
            <tbody>
              {fips.map((f) => (
                <tr key={f.id}>
                  <td className="mono"><b>{f.floating_ip_address}</b></td>
                  <td><StatusBadge status={f.status} /></td>
                  <td>{f.instance_name || <span className="dim">—</span>}</td>
                  <td className="mono dim">{f.fixed_ip_address || '—'}</td>
                  <td>
                    <ActionsMenu items={[
                      !f.port_id && { label: t('floatingIps.associate'), onClick: () => setAssocFor(f) },
                      f.port_id && { label: t('floatingIps.disassociate'), onClick: () => disassociate(f) },
                      'divider',
                      { label: t('floatingIps.release'), danger: true, disabled: !!f.port_id, onClick: () => release(f) },
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

export function AllocateModal({ onClose, onDone }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (busy) return;
    setBusy(true);
    try {
      const d = await api('/floatingips', { method: 'POST' });
      toast(t('floatingIps.allocated', { ip: d.floatingip.floating_ip_address }), 'ok');
      onDone();
    } catch (e) { toast(e.message, 'error'); setBusy(false); }
  }

  return (
    <Modal title={t('floatingIps.allocateTitle')} onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn primary" onClick={submit} disabled={busy}>{t('floatingIps.allocateSubmit')}</button></>}>
      <p className="dim">{t('floatingIps.automaticAllocation')}</p>
    </Modal>
  );
}

function AssociateModal({ fip, onClose, onDone }) {
  const { t } = useI18n();
  const [servers, setServers] = useState([]);
  const [sid, setSid] = useState('');
  const [portId, setPortId] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    api(`/floatingips/${fip.id}/eligible-servers`).then((d) => {
      if (!active) return;
      setServers(d.servers);
      setSid(d.servers[0]?.id || '');
      setLoading(false);
    }).catch((e) => { if (active) { setLoadError(e.message); setLoading(false); } });
    return () => { active = false; };
  }, [fip.id]);

  const selectedServer = servers.find((server) => server.id === sid);

  async function submit() {
    if (busy || !sid || (selectedServer?.ports.length > 1 && !portId)) return;
    setBusy(true);
    try {
      await api(`/floatingips/${fip.id}/associate`, { method: 'POST', body: {
        server_id: sid, ...(selectedServer?.ports.length > 1 ? { port_id: portId } : {}),
      } });
      toast(t('floatingIps.associated'), 'ok');
      onDone();
    } catch (e) { toast(e.message, 'error'); setBusy(false); }
  }

  return (
    <Modal title={t('floatingIps.associateTitle', { ip: fip.floating_ip_address })} onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn primary" onClick={submit} disabled={busy || loading || !sid || (selectedServer?.ports.length > 1 && !portId)}>{t('floatingIps.associateSubmit')}</button></>}>
      {loading ? <Empty>{t('common.loading')}</Empty> : loadError ? <Empty>{loadError}</Empty> : !servers.length ? (
        <Empty>{t('floatingIps.noEligibleInstances')}</Empty>
      ) : <>
        <Field label={t('floatingIps.selectInstance')}>
          <select value={sid} onChange={(e) => { setSid(e.target.value); setPortId(''); }}>
            {servers.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.ports.map((port) => port.fixed_ips.join(', ')).join('; ')})</option>)}
          </select>
        </Field>
        {selectedServer?.ports.length > 1 && <Field label={t('floatingIps.selectInterface')}>
          <select value={portId} onChange={(e) => setPortId(e.target.value)}>
            <option value="">{t('floatingIps.selectInterface')}</option>
            {selectedServer.ports.map((port) => <option key={port.id} value={port.id}>{port.fixed_ips.join(', ') || '—'}</option>)}
          </select>
        </Field>}
      </>}
    </Modal>
  );
}
