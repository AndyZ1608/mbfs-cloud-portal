import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Modal, Field, Empty, toast } from './ui.jsx';
import FixedIpInput from './FixedIpInput.jsx';
import { fixedIpError } from '../fixedIp.js';
import { useI18n } from '../i18n/react.jsx';

export function CreateVipModal({ subnet, onClose, onDone }) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [ip, setIp] = useState('');
  const [busy, setBusy] = useState(false);
  const ipError = ip ? fixedIpError(ip, subnet) : 'required';
  async function submit() {
    if (!name.trim() || ipError || busy) return;
    setBusy(true);
    try {
      await api(`/subnets/${encodeURIComponent(subnet.id)}/vips`, { method: 'POST',
        body: { name: name.trim(), ip_address: ip } });
      toast(t('vip.createSuccess'), 'ok');
      onDone();
    } catch (error) { toast(error.message, 'error'); setBusy(false); }
  }
  return <Modal title={t('vip.create')} onClose={() => !busy && onClose()}
    footer={<><button className="btn ghost" disabled={busy} onClick={onClose}>{t('common.cancel')}</button>
      <button className="btn primary" disabled={busy || !name.trim() || !!ipError} onClick={submit}>{t('vip.create')}</button></>}>
    <Field label={`${t('vip.name')} *`}><input value={name} disabled={busy} onChange={(event) => setName(event.target.value)} autoFocus /></Field>
    <FixedIpInput subnet={subnet} value={ip} onChange={setIp} disabled={busy} required labelKey="vip.address" />
    <p className="field-hint">{t('instance.networkInterfaces.subnet')}: {subnet.name || subnet.id} · {subnet.cidr}</p>
  </Modal>;
}

export function VipAssignmentsModal({ vip, onClose, onDone }) {
  const { t } = useI18n();
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    api(`/vips/${encodeURIComponent(vip.id)}/assignments`).then((result) => {
      if (!live) return;
      setData(result); setSelected(new Set(result.targets.filter((target) => target.assigned).map((target) => target.id)));
    }).catch((failure) => { if (live) setError(failure.message); });
    return () => { live = false; };
  }, [vip.id]);
  function toggle(id) {
    setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }
  async function save() {
    if (busy) return;
    setBusy(true);
    try {
      await api(`/vips/${encodeURIComponent(vip.id)}/assignments`, { method: 'PUT', body: { port_ids: [...selected] } });
      toast(t('vip.assignmentUpdated'), 'ok'); onDone();
    } catch (failure) {
      toast(failure.message, 'error');
      if (failure.code === 'vip_partial_failure') onDone();
      else setBusy(false);
    }
  }
  return <Modal title={`${t('vip.manageAssignments')} — ${vip.name || vip.id}`} wide onClose={() => !busy && onClose()}
    footer={<><button className="btn ghost" disabled={busy} onClick={onClose}>{t('common.cancel')}</button>
      <button className="btn primary" disabled={busy || !data} onClick={save}>{t('common.save')}</button></>}>
    <p className="mono">{vip.fixed_ips?.[0]?.ip_address}</p>
    {error ? <p className="err-text" role="alert">{error}</p> : !data ? <Empty>{t('common.loading')}</Empty>
      : !data.targets.length ? <Empty>{t('vip.noEligibleInterfaces')}</Empty> : <div className="vip-choice-list">
        {data.targets.map((target) => <label className="vip-choice" key={target.id}>
          <input type="checkbox" checked={selected.has(target.id)} disabled={busy} onChange={() => toggle(target.id)} />
          <span><strong>{target.instance_name || target.device_id}</strong>
            <small>{target.name || target.id} · {target.fixed_ips?.map((fixed) => fixed.ip_address).join(', ')}</small></span>
        </label>)}
      </div>}
  </Modal>;
}

export function PortVipsModal({ portId, onClose, onDone }) {
  const { t } = useI18n();
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    api(`/ports/${encodeURIComponent(portId)}/vips`).then((result) => {
      if (!live) return;
      setData(result); setSelected(new Set(result.vips.filter((vip) => vip.assigned).map((vip) => vip.id)));
    }).catch((failure) => { if (live) setError(failure.message); });
    return () => { live = false; };
  }, [portId]);
  function toggle(id) {
    setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }
  async function save() {
    if (busy) return;
    setBusy(true);
    try {
      await api(`/ports/${encodeURIComponent(portId)}/vips`, { method: 'PUT', body: { vip_port_ids: [...selected] } });
      toast(t('vip.assignmentUpdated'), 'ok'); onDone();
    } catch (failure) { toast(failure.message, 'error'); setBusy(false); }
  }
  return <Modal title={t('instance.networking.manageVips')} wide onClose={() => !busy && onClose()}
    footer={<><button className="btn ghost" disabled={busy} onClick={onClose}>{t('common.cancel')}</button>
      <button className="btn primary" disabled={busy || !data} onClick={save}>{t('common.save')}</button></>}>
    {error ? <p className="err-text" role="alert">{error}</p> : !data ? <Empty>{t('common.loading')}</Empty> : <>
      {!data.vips.length ? <Empty>{t('vip.noAvailable')}</Empty> : <div className="vip-choice-list">
        {data.vips.map((vip) => <label className="vip-choice" key={vip.id}>
          <input type="checkbox" checked={selected.has(vip.id)} disabled={busy} onChange={() => toggle(vip.id)} />
          <span><strong>{vip.name || vip.id}</strong><small>{vip.fixed_ips?.[0]?.ip_address}</small></span>
        </label>)}
      </div>}
      {!!data.external_pairs?.length && <div className="vip-external"><strong>{t('instance.networking.externalAddressPair')}</strong>
        {data.external_pairs.map((pair, index) => <span className="mono" key={`${pair.ip_address}-${index}`}>{pair.ip_address}</span>)}</div>}
    </>}
  </Modal>;
}
