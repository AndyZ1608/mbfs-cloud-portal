import React, { useEffect, useState } from 'react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import { api, fmtDate } from '../api.js';
import { Empty, Field, Modal, StatusBadge, toast } from '../components/ui.jsx';
import { AttachVipModal, CreateVipModal, VipAssignmentsModal } from '../components/VipModals.jsx';
import NetworkEditModal from '../components/NetworkEditModal.jsx';
import { useI18n } from '../i18n/react.jsx';

export function portType(port) {
  if (port.cmp_vip) return 'vip';
  if (port.device_owner?.startsWith('compute:')) return 'vm';
  if (port.device_owner?.includes('router')) return 'router';
  if (port.device_owner?.includes('dhcp')) return 'dhcp';
  return 'other';
}

export default function NetworkDetailRoute() {
  const { networkId } = useParams();
  const { sess } = useOutletContext();
  return <NetworkDetail key={`${sess.project.id}:${networkId}`} networkId={networkId} />;
}

function CreateSubnetModal({ network, onClose, onDone }) {
  const { t } = useI18n();
  const [form, setForm] = useState({ cidr: '', gateway_ip: '', dns: '' });
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (busy || !form.cidr.trim()) return;
    setBusy(true);
    try {
      await api(`/networks/${encodeURIComponent(network.id)}/subnet`, { method: 'POST', body: form });
      toast(t('network.detail.subnetCreated'), 'ok'); onDone();
    } catch (error) { toast(error.message, 'error'); setBusy(false); }
  }
  return <Modal title={t('network.detail.createSubnet')} onClose={() => !busy && onClose()}
    footer={<><button className="btn ghost" disabled={busy} onClick={onClose}>{t('common.cancel')}</button>
      <button className="btn primary" disabled={busy || !form.cidr.trim()} onClick={submit}>{t('network.detail.createSubnet')}</button></>}>
    <Field label="CIDR"><input value={form.cidr} disabled={busy} placeholder="10.0.0.0/24"
      onChange={(event) => setForm({ ...form, cidr: event.target.value })} /></Field>
    <Field label={t('subnet.detail.gateway')}><input value={form.gateway_ip} disabled={busy}
      onChange={(event) => setForm({ ...form, gateway_ip: event.target.value })} /></Field>
    <Field label={t('subnet.detail.dns')}><input value={form.dns} disabled={busy}
      onChange={(event) => setForm({ ...form, dns: event.target.value })} /></Field>
  </Modal>;
}

function NetworkDetail({ networkId }) {
  const { t } = useI18n();
  const [state, setState] = useState({ loading: true });
  const [revision, setRevision] = useState(0);
  const [creatingSubnet, setCreatingSubnet] = useState(false);
  const [creatingVip, setCreatingVip] = useState(false);
  const [assigning, setAssigning] = useState(null);
  const [attaching, setAttaching] = useState(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const refresh = () => setRevision((value) => value + 1);

  useEffect(() => {
    let live = true;
    setState({ loading: true });
    api(`/networks/${encodeURIComponent(networkId)}/resources`).then((data) => {
      if (live) setState(data);
    }).catch((error) => { if (live) setState({ error: error.message }); });
    return () => { live = false; };
  }, [networkId, revision]);

  async function remove(vip) {
    if (deleting || vip.assignment_count) return;
    if (!window.confirm(t('vip.deleteConfirm', { name: vip.name || vip.fixed_ips?.[0]?.ip_address }))) return;
    setDeleting(true);
    try {
      await api(`/vips/${encodeURIComponent(vip.id)}`, { method: 'DELETE' });
      toast(t('vip.deleteSuccess'), 'ok'); refresh();
    } catch (error) { toast(error.message, 'error'); }
    finally { setDeleting(false); }
  }

  if (state.loading) return <Empty>{t('common.loading')}</Empty>;
  if (state.error) return <div className="vm-detail-error" role="alert">{state.error}</div>;
  const { network, subnet, subnet_state: subnetState, ports, vips } = state;
  return <div className="vm-detail-page">
    <nav className="vm-detail-breadcrumb"><Link to="/networks">{t('navigation.networks')}</Link> / {network.name}</nav>
    <div className="card vm-detail-header"><div className="vm-detail-heading"><div><h2>{network.name}</h2>
      <StatusBadge status={network.status} /></div><div className="vip-row-actions">
        {!network['router:external'] && !network.shared && <button className="btn ghost" onClick={() => setEditing(true)}>{t('network.actions.edit')}</button>}
        <button className="btn ghost" onClick={refresh}>{t('common.refresh')}</button></div></div>
      {subnet && <div className="vm-detail-summary"><span>CIDR: <b>{subnet.cidr}</b></span>
        <span>{t('subnet.detail.gateway')}: <b>{subnet.gateway_ip || '—'}</b></span>
        <span>DHCP: <b>{t(subnet.enable_dhcp ? 'networks.on' : 'networks.off')}</b></span></div>}
    </div>
    {subnetState === 'none' && <section className="card vm-detail-content"><h3>{t('network.detail.noSubnetTitle')}</h3>
      <Empty>{t('network.detail.noSubnetHelp')}</Empty>
      <button className="btn primary" disabled={network.shared || network['router:external']}
        onClick={() => setCreatingSubnet(true)}>{t('network.detail.createSubnet')}</button></section>}
    {subnetState === 'multiple' && <section className="card vm-detail-content"><div className="vm-detail-error" role="alert">
      {t('network.detail.multipleSubnets')}</div></section>}
    <section className="card vm-detail-content"><h3>{t('network.detail.ports')}</h3>
        {!ports.length ? <Empty>{t('subnet.detail.noPorts')}</Empty> : <div className="vm-detail-table"><table className="tbl">
          <thead><tr>{['name', 'fixedIp', 'device', 'type', 'status', 'admin'].map((key) =>
            <th key={key}>{t(`subnet.port.${key}`)}</th>)}</tr></thead>
          <tbody>{ports.map((port) => <tr key={port.id}><td>{port.name || '—'}</td>
            <td className="mono">{port.fixed_ips?.filter((fixed) => !subnet || fixed.subnet_id === subnet.id)
              .map((fixed) => fixed.ip_address).join(', ') || '—'}</td>
            <td>{port.instance_name || (port.device_owner ? t(`subnet.port.type.${portType(port)}`) : '—')}</td>
            <td>{t(`subnet.port.type.${portType(port)}`)}</td><td><StatusBadge status={port.status} /></td>
            <td>{t(port.admin_state_up ? 'common.yes' : 'common.no')}</td></tr>)}</tbody>
        </table></div>}</section>
    {subnetState === 'single' && <section className="card vm-detail-content"><div className="vm-detail-section-head"><h3>{t('subnet.detail.virtualIps')}</h3>
        <button className="btn primary sm" onClick={() => setCreatingVip(true)}>{t('vip.create')}</button></div>
        {!vips.length ? <Empty>{t('vip.noAvailable')}</Empty> : <div className="vm-detail-table"><table className="tbl">
          <thead><tr>{['name', 'address', 'assignedInterfaces', 'state', 'created', 'actions'].map((key) =>
            <th key={key}>{t(`vip.${key}`)}</th>)}</tr></thead>
          <tbody>{vips.map((vip) => <tr key={vip.id}><td>{vip.name || vip.fixed_ips?.[0]?.ip_address}</td>
            <td className="mono">{vip.fixed_ips?.[0]?.ip_address}</td><td>{vip.assignment_count}</td><td>{t('vip.reserved')}</td>
            <td>{fmtDate(vip.created_at)}</td><td><div className="vip-row-actions">
              <button className="btn ghost sm" onClick={() => setAttaching(vip)}>{t('vip.attachToVm')}</button>
              <button className="btn ghost sm" onClick={() => setAssigning(vip)}>{t('vip.manageAssignments')}</button>
              <button className="btn danger-ghost sm" disabled={deleting || vip.assignment_count > 0} onClick={() => remove(vip)}>{t('vip.delete')}</button>
            </div></td></tr>)}</tbody></table></div>}</section>}
    {creatingSubnet && <CreateSubnetModal network={network} onClose={() => setCreatingSubnet(false)}
      onDone={() => { setCreatingSubnet(false); refresh(); }} />}
    {creatingVip && <CreateVipModal subnet={subnet} onClose={() => setCreatingVip(false)}
      onDone={() => { setCreatingVip(false); refresh(); }} />}
    {assigning && <VipAssignmentsModal vip={assigning} onClose={() => setAssigning(null)}
      onDone={() => { setAssigning(null); refresh(); }} />}
    {attaching && <AttachVipModal vip={attaching} onClose={() => setAttaching(null)}
      onDone={() => { setAttaching(null); refresh(); }} />}
    {editing && <NetworkEditModal networkId={network.id} onClose={() => setEditing(false)}
      onDone={() => { setEditing(false); refresh(); }} />}
  </div>;
}
