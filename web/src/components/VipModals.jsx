import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Modal, Field, Empty, toast } from './ui.jsx';
import FixedIpInput from './FixedIpInput.jsx';
import { fixedIpError } from '../fixedIp.js';
import { useI18n } from '../i18n/react.jsx';
import { filterVipAssignmentVms, toggleVipPort, vipAssignmentVms } from '../vipAssignments.js';

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
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const vms = useMemo(() => vipAssignmentVms(data?.targets, data?.subnet?.id), [data]);
  const visibleVms = filterVipAssignmentVms(vms, search);
  useEffect(() => {
    let live = true;
    setData(null);
    setSelected(new Set());
    setError(false);
    setSearch('');
    api(`/vips/${encodeURIComponent(vip.id)}/assignments`).then((result) => {
      if (!live) return;
      setData(result); setSelected(new Set(result.targets.filter((target) => target.assigned).map((target) => target.id)));
    }).catch(() => { if (live) setError(true); });
    return () => { live = false; };
  }, [vip.id]);
  function toggle(id) {
    setSelected((current) => toggleVipPort(current, id));
  }
  async function save() {
    if (busy) return;
    setBusy(true);
    try {
      await api(`/vips/${encodeURIComponent(vip.id)}/assignments`, { method: 'PUT', body: { port_ids: [...selected] } });
      toast(t('vip.assignmentUpdated'), 'ok'); onDone();
    } catch (failure) {
      toast(failure.code === 'vip_partial_failure' ? t('vip.assignments.partialFailure') : failure.message, 'error');
      if (failure.code === 'vip_partial_failure') onDone();
      else setBusy(false);
    }
  }
  return <Modal title={`${t('vip.assignments.title')} — ${vip.name || t('vip.assignments.unnamedVip')}`}
    wide className="vip-assignments-modal" onClose={() => !busy && onClose()}
    footer={<><button className="btn ghost" disabled={busy} onClick={onClose}>{t('common.cancel')}</button>
      <button className="btn primary" disabled={busy || !data || error || !vms.length} onClick={save}>{t('vip.assignments.save')}</button></>}>
    <div className="vip-assignment-summary"><span>{t('vip.assignments.vip')}</span>
      <strong className="mono">{vip.fixed_ips?.[0]?.ip_address || '—'}</strong></div>
    {error ? <p className="err-text" role="alert">{t('vip.assignments.loadError')}</p>
      : !data ? <Empty>{t('vip.assignments.loading')}</Empty>
        : !vms.length ? <VipAssignmentChoices vms={vms} selected={selected} onToggle={toggle} busy={busy} /> : <>
          <label className="vip-assignment-search"><span>{t('vip.assignments.selectInstances')}</span>
            <input type="search" value={search} onChange={(event) => setSearch(event.target.value)}
              placeholder={t('vip.assignments.search')} autoComplete="off" /></label>
          {!visibleVms.length ? <Empty>{t('vip.assignments.noSearchResults')}</Empty>
            : <VipAssignmentChoices vms={visibleVms} selected={selected} onToggle={toggle} busy={busy} />}
        </>}
  </Modal>;
}

export function VipAssignmentChoices({ vms, selected, onToggle, busy = false }) {
  const { t } = useI18n();
  if (!vms.length) return <Empty>{t('vip.assignments.noEligibleInstances')}</Empty>;
  return <div className="vip-assignment-list">
    {vms.map((vm) => vm.interfaces.length === 1 ? <label className="vip-vm-choice vip-vm-choice-single" key={vm.instanceId}>
      <input type="checkbox" checked={selected.has(vm.interfaces[0].portId)} disabled={busy}
        onChange={() => onToggle(vm.interfaces[0].portId)} />
      <span className="vip-vm-identity"><strong>{vm.instanceName || t('vip.assignments.unnamedVm')}</strong>
        {vm.interfaces[0].fixedIp && <small>{vm.interfaces[0].fixedIp}</small>}</span>
    </label> : <div className="vip-vm-choice" key={vm.instanceId}>
      <strong className="vip-vm-name">{vm.instanceName || t('vip.assignments.unnamedVm')}</strong>
      <span className="vip-interface-caption">{t('vip.assignments.interface')}</span>
      <div className="vip-interface-list">{vm.interfaces.map((item) => <label className="vip-interface-choice" key={item.portId}>
        <input type="checkbox" checked={selected.has(item.portId)} disabled={busy}
          onChange={() => onToggle(item.portId)} />
        <span>{item.fixedIp || '—'}</span>
      </label>)}</div>
    </div>)}
  </div>;
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
