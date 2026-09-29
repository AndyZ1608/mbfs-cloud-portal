import React, { useEffect, useState } from 'react';
import { Link, useOutletContext, useParams, useSearchParams } from 'react-router-dom';
import { api, fmtDate } from '../api.js';
import { Empty, StatusBadge, toast } from '../components/ui.jsx';
import { CreateVipModal, VipAssignmentsModal } from '../components/VipModals.jsx';
import { useI18n } from '../i18n/react.jsx';

const tabs = ['overview', 'ports', 'virtualIps'];

export function portType(port) {
  if (port.cmp_vip) return 'vip';
  if (port.device_owner?.startsWith('compute:')) return 'vm';
  if (port.device_owner?.includes('router')) return 'router';
  if (port.device_owner?.includes('dhcp')) return 'dhcp';
  return 'other';
}

export default function SubnetDetailRoute() {
  const { networkId, subnetId } = useParams();
  const { sess } = useOutletContext();
  return <SubnetDetail key={`${sess.project.id}:${networkId}:${subnetId}`} networkId={networkId} subnetId={subnetId} />;
}

function SubnetDetail({ networkId, subnetId }) {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const tab = tabs.includes(params.get('tab')) ? params.get('tab') : 'overview';
  const [summary, setSummary] = useState({ loading: true });
  const [tabState, setTabState] = useState({});
  const [revision, setRevision] = useState(0);
  const [creating, setCreating] = useState(false);
  const [assigning, setAssigning] = useState(null);
  const refresh = () => setRevision((number) => number + 1);

  useEffect(() => {
    let live = true;
    api(`/subnets/${encodeURIComponent(subnetId)}`).then((data) => {
      if (live) setSummary(data.network.id === networkId ? data : { error: t('errors.resource_not_found') });
    }).catch((error) => { if (live) setSummary({ error: error.message }); });
    return () => { live = false; };
  }, [networkId, subnetId, revision]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tab === 'overview' || !summary.subnet) return;
    let live = true;
    setTabState((current) => ({ ...current, [tab]: { loading: true } }));
    const path = tab === 'ports' ? 'ports' : 'vips';
    api(`/subnets/${encodeURIComponent(subnetId)}/${path}`).then((data) => {
      if (live) setTabState((current) => ({ ...current, [tab]: { data } }));
    }).catch((error) => { if (live) setTabState((current) => ({ ...current, [tab]: { error: error.message } })); });
    return () => { live = false; };
  }, [tab, subnetId, revision, summary.subnet?.id]);

  async function remove(vip) {
    if (vip.assignment_count) return;
    if (!window.confirm(t('vip.deleteConfirm', { name: vip.name || vip.id }))) return;
    try {
      await api(`/vips/${encodeURIComponent(vip.id)}`, { method: 'DELETE' });
      toast(t('vip.deleteSuccess'), 'ok'); refresh();
    } catch (error) { toast(error.message, 'error'); }
  }

  if (summary.loading) return <Empty>{t('common.loading')}</Empty>;
  if (summary.error) return <div className="vm-detail-error" role="alert">{summary.error}</div>;
  const { subnet, network } = summary;
  const current = tabState[tab] || {};
  return <div className="vm-detail-page">
    <nav className="vm-detail-breadcrumb"><Link to="/networks">{t('navigation.networks')}</Link> / <Link to={`/networks/${encodeURIComponent(network.id)}`}>{network.name}</Link> / {subnet.name || subnet.cidr}</nav>
    <div className="card vm-detail-header"><div className="vm-detail-heading"><div><h2>{subnet.name || subnet.cidr}</h2>
      <span className="mono dim">{subnet.id}</span></div><button className="btn ghost" onClick={refresh}>{t('common.refresh')}</button></div>
      <div className="vm-detail-summary"><span>CIDR: <b>{subnet.cidr}</b></span><span>{t('subnet.detail.network')}: <b>{network.name}</b></span></div>
    </div>
    <nav className="vm-detail-tabs" aria-label={t('subnet.detail.tabs')}>{tabs.map((key) => <button key={key}
      className={tab === key ? 'active' : ''} aria-current={tab === key ? 'page' : undefined}
      onClick={() => setParams(key === 'overview' ? {} : { tab: key })}>{t(`subnet.detail.${key}`)}</button>)}</nav>
    <section className="card vm-detail-content">
      {tab === 'overview' && <div className="vm-detail-fields">
        {[[t('common.name'), subnet.name || '—'], [t('subnet.detail.subnetId'), subnet.id],
          [t('subnet.detail.network'), network.name], ['CIDR', subnet.cidr],
          [t('subnet.detail.gateway'), subnet.gateway_ip || '—'], ['DHCP', t(subnet.enable_dhcp ? 'networks.on' : 'networks.off')],
          [t('subnet.detail.ipVersion'), subnet.ip_version || '—'],
          [t('subnet.detail.dns'), subnet.dns_nameservers?.join(', ') || '—'],
          [t('subnet.detail.allocationPools'), subnet.allocation_pools?.map((pool) => `${pool.start} – ${pool.end}`).join(', ') || '—']]
          .map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}
      </div>}
      {tab !== 'overview' && current.loading && <Empty>{t('common.loading')}</Empty>}
      {tab !== 'overview' && current.error && <div className="vm-detail-error" role="alert">{current.error}</div>}
      {tab === 'ports' && current.data && <><h3>{t('subnet.detail.ports')}</h3>
        {!current.data.ports.length ? <Empty>{t('subnet.detail.noPorts')}</Empty> : <div className="vm-detail-table"><table className="tbl">
          <thead><tr>{['name', 'type', 'fixedIp', 'mac', 'device', 'status', 'admin', 'portSecurity', 'allowedPairs'].map((key) => <th key={key}>{t(`subnet.port.${key}`)}</th>)}</tr></thead>
          <tbody>{current.data.ports.map((port) => <tr key={port.id}><td>{port.name || <span className="mono">{port.id}</span>}</td>
            <td>{t(`subnet.port.type.${portType(port)}`)}</td><td className="mono">{port.fixed_ips?.filter((fixed) => fixed.subnet_id === subnetId).map((fixed) => fixed.ip_address).join(', ')}</td>
            <td className="mono">{port.mac_address || '—'}</td><td className="mono">{port.device_id || '—'}</td>
            <td><StatusBadge status={port.status} /></td><td>{t(port.admin_state_up ? 'common.yes' : 'common.no')}</td>
            <td>{t(port.port_security_enabled ? 'common.yes' : 'common.no')}</td>
            <td className="mono">{port.allowed_address_pairs?.map((pair) => pair.ip_address).join(', ') || '—'}</td></tr>)}</tbody>
        </table></div>}</>}
      {tab === 'virtualIps' && current.data && <><div className="vm-detail-section-head"><h3>{t('subnet.detail.virtualIps')}</h3>
        <button className="btn primary sm" onClick={() => setCreating(true)}>{t('vip.create')}</button></div>
        {!current.data.vips.length ? <Empty>{t('vip.noAvailable')}</Empty> : <div className="vm-detail-table"><table className="tbl">
          <thead><tr>{['name', 'address', 'assignedInterfaces', 'state', 'created', 'actions'].map((key) => <th key={key}>{t(`vip.${key}`)}</th>)}</tr></thead>
          <tbody>{current.data.vips.map((vip) => <tr key={vip.id}><td>{vip.name || vip.id}</td>
            <td className="mono">{vip.fixed_ips?.[0]?.ip_address}</td><td>{vip.assignment_count}</td><td>{t('vip.reserved')}</td>
            <td>{fmtDate(vip.created_at)}</td><td><div className="vip-row-actions">
              <button className="btn ghost sm" onClick={() => setAssigning(vip)}>{t('vip.manageAssignments')}</button>
              <button className="btn danger-ghost sm" disabled={vip.assignment_count > 0} onClick={() => remove(vip)}>{t('vip.delete')}</button>
            </div></td></tr>)}</tbody></table></div>}
      </>}
    </section>
    {creating && <CreateVipModal subnet={subnet} onClose={() => setCreating(false)} onDone={() => { setCreating(false); refresh(); }} />}
    {assigning && <VipAssignmentsModal vip={assigning} onClose={() => setAssigning(null)} onDone={() => { setAssigning(null); refresh(); }} />}
  </div>;
}
