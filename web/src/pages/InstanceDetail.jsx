import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useOutletContext, useParams, useSearchParams } from 'react-router-dom';
import { api, fmtDate, ramGB, serverIps } from '../api.js';
import { ActionsMenu, Empty, Modal, StatusBadge, toast } from '../components/ui.jsx';
import { openInstanceConsole } from '../console/navigation.js';
import { useI18n } from '../i18n/react.jsx';
import useInstanceActions from '../useInstanceActions.js';
import { InstanceActionDialogs } from './Instances.jsx';
import { attachedSecurityGroups, attachedStorage, canDetachVolume, networkRows } from '../instanceDetailData.js';

const TABS = ['overview', 'networking', 'storage', 'security', 'activity'];
const value = (item) => item === undefined || item === null || item === '' ? '—' : item;
const activityLabel = (t, prefix, raw) => {
  const key = `instance.activity.${prefix}.${raw}`;
  const translated = t(key);
  return translated === key ? value(raw) : translated;
};

function DetailFields({ rows }) {
  return <div className="vm-detail-fields">{rows.map(([label, content]) =>
    <div key={label}><span>{label}</span><strong>{content ?? '—'}</strong></div>)}</div>;
}

function TabState({ state, children, empty, errorKey, t }) {
  if (state.loading || !state.loaded && !state.error) return <Empty>{t('common.loading')}</Empty>;
  if (state.error) return <div className="vm-detail-error" role="alert">{t(errorKey)} <span>{state.error}</span></div>;
  if (empty) return <Empty>{t(empty)}</Empty>;
  return children;
}

export default function InstanceDetailRoute() {
  const { instanceId } = useParams();
  return <InstanceDetail key={instanceId} instanceId={instanceId} />;
}

function InstanceDetail({ instanceId }) {
  const { t } = useI18n();
  const { sess } = useOutletContext();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = TABS.includes(params.get('tab')) ? params.get('tab') : 'overview';
  const [server, setServer] = useState(null);
  const [serverError, setServerError] = useState(null);
  const [serverRevision, setServerRevision] = useState(0);
  const [tabRevision, setTabRevision] = useState(0);
  const [tabStates, setTabStates] = useState({});
  const [resolvedImage, setResolvedImage] = useState(null);
  const [flavor, setFlavor] = useState(null);
  const [attachVolumeOpen, setAttachVolumeOpen] = useState(false);
  const [selectedVolumeId, setSelectedVolumeId] = useState('');
  const [volumeBusy, setVolumeBusy] = useState(false);
  const current = tabStates[tab] || {};
  const encodedId = encodeURIComponent(instanceId);

  function refresh() {
    setServerRevision((n) => n + 1);
    setTabRevision((n) => n + 1);
  }
  const actions = useInstanceActions({ onChanged: refresh, onDeleted: () => navigate('/instances') });

  useEffect(() => {
    let live = true;
    api(`/servers/${encodedId}`).then(({ server: next }) => {
      if (!live) return;
      setServer(next);
      setServerError(null);
      actions.syncServers([next]);
    }).catch((error) => {
      if (!live) return;
      setServer(null);
      setTabStates({});
      setServerError(error);
    });
    return () => { live = false; };
  }, [encodedId, sess.project.id, serverRevision]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const timer = setInterval(() => setServerRevision((n) => n + 1), 10000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!server) return;
    let live = true;
    if (server.flavor?.vcpus == null) {
      api('/flavors').then(({ flavors }) => {
        if (live) setFlavor(flavors.find((item) => item.id === server.flavor?.id) || null);
      }).catch(() => {});
    }
    if (server.image?.id) {
      api('/images').then(({ images }) => {
        if (live) setResolvedImage({ id: server.image.id, name: images.find((item) => item.id === server.image.id)?.name || null });
      }).catch(() => {});
    }
    return () => { live = false; };
  }, [server?.id, server?.image?.id, server?.flavor?.id]);

  useEffect(() => {
    if (!server || tab === 'overview') return;
    let live = true;
    setTabStates((states) => ({ ...states, [tab]: { ...states[tab], loading: true, error: null } }));
    const loaders = {
      networking: async () => {
        const [ports, networks, fips, groups] = await Promise.all([
          api(`/servers/${encodedId}/interfaces`), api('/available-networks'),
          api('/floatingips'), api('/security-groups'),
        ]);
        return networkRows(ports.interfaces, networks.networks, fips.floatingips, groups.security_groups);
      },
      storage: async () => {
        const [nova, cinder, snapshots] = await Promise.all([
          api(`/servers/${encodedId}/volumes`), api('/volumes'), api('/snapshots').catch((error) => ({ error: error.message })),
        ]);
        return { ...attachedStorage(nova.volumeAttachments || [], cinder.volumes || [], snapshots.snapshots || [], server.id),
          available: (cinder.volumes || []).filter((volume) => volume.status === 'available'),
          snapshotError: snapshots.error || null };
      },
      security: async () => {
        const [ports, groups] = await Promise.all([api(`/servers/${encodedId}/interfaces`), api('/security-groups')]);
        return attachedSecurityGroups(ports.interfaces, groups.security_groups, server.security_groups);
      },
      activity: async () => (await api(`/servers/${encodedId}/activity`)).entries || [],
    };
    loaders[tab]().then((data) => {
      if (live) setTabStates((states) => ({ ...states, [tab]: { loaded: true, loading: false, data } }));
    }).catch((error) => {
      if (live) setTabStates((states) => ({ ...states, [tab]: { loaded: false, loading: false, error: error.message } }));
    });
    return () => { live = false; };
  }, [server?.id, tab, tabRevision, encodedId, sess.project.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (serverError) return <div className="vm-detail-error" role="alert">{t('instance.detail.unavailable')} <span>{serverError.message}</span><div><Link to="/instances">{t('navigation.instances')}</Link></div></div>;
  if (!server) return <Empty>{t('common.loading')}</Empty>;

  const specs = server.flavor?.vcpus != null ? server.flavor
    : flavor?.id === server.flavor?.id ? flavor : server.flavor || {};
  const ips = serverIps(server);
  const tabData = current.data;
  const bootFromVolume = !server.image?.id && (server['os-extended-volumes:volumes_attached'] || []).length > 0;
  const image = server.image?.id ? (resolvedImage?.id === server.image.id && resolvedImage.name || server.image.id)
    : bootFromVolume ? t('instance.detail.bootFromVolume') : '—';
  const rootDisk = server.image?.id && specs.disk > 0
    ? t('instance.detail.ephemeralDisk', { size: specs.disk })
    : bootFromVolume
      ? t('instance.detail.bootFromVolume') : '—';
  async function attachVolume() {
    if (!selectedVolumeId || volumeBusy) return;
    setVolumeBusy(true);
    try {
      await api(`/volumes/${encodeURIComponent(selectedVolumeId)}/attach`, { method: 'POST', body: { server_id: server.id } });
      toast(t('volumes.attaching'), 'ok');
      setAttachVolumeOpen(false);
      setSelectedVolumeId('');
      refresh();
    } catch (error) { toast(error.message, 'error'); }
    finally { setVolumeBusy(false); }
  }
  async function detachVolume(volume) {
    if (!window.confirm(t('instance.detail.detachConfirm', { name: volume.name || volume.id }))) return;
    try {
      await api(`/volumes/${encodeURIComponent(volume.id)}/detach`, { method: 'POST', body: { server_id: server.id } });
      toast(t('volumes.detaching'), 'ok');
      refresh();
    } catch (error) { toast(error.message, 'error'); }
  }
  async function snapshotVolume(volume) {
    const name = window.prompt(t('volumes.snapshotName'), `${volume.name || 'vol'}-snap-${new Date().toISOString().slice(0, 10)}`);
    if (!name) return;
    try {
      await api('/snapshots', { method: 'POST', body: { volume_id: volume.id, name } });
      toast(t('volumes.snapshotCreating'), 'ok');
      refresh();
    } catch (error) { toast(error.message, 'error'); }
  }
  return <div className="vm-detail-page">
    <nav className="vm-detail-breadcrumb" aria-label={t('instance.detail.breadcrumb')}>
      <Link to="/instances">{t('navigation.compute')} / {t('navigation.instances')}</Link><span> / {server.name}</span>
    </nav>
    <div className="vm-detail-header card">
      <div className="vm-detail-heading"><div><h2>{server.name}</h2><div className="vm-detail-identity"><StatusBadge status={server.status} /><span className="mono">{server.id}</span></div></div>
        <div className="vm-detail-actions"><button className="btn primary" onClick={() => openInstanceConsole(server.id)}>{t('instance.detail.openConsole')}</button>
          <ActionsMenu items={actions.items(server)} /><button className="btn ghost" onClick={refresh}>{t('common.refresh')}</button></div></div>
      <div className="vm-detail-summary">
        <span>{t('instance.detail.project')}: <b>{sess.project.name}</b></span>
        <span>{t('instance.detail.flavor')}: <b>{value(specs.original_name || specs.name || specs.id)}</b></span>
        <span>{t('instance.detail.created')}: <b>{fmtDate(server.created)}</b></span>
        <span>{t('instance.detail.ipAddresses')}: <b>{ips.map((item) => item.ip).join(', ') || '—'}</b></span>
      </div>
    </div>
    <nav className="vm-detail-tabs" aria-label={t('instance.detail.tabs')}>
      {TABS.map((key) => <button key={key} className={tab === key ? 'active' : ''} aria-current={tab === key ? 'page' : undefined}
        onClick={() => setParams(key === 'overview' ? {} : { tab: key })}>{t(`instance.detail.${key}`)}</button>)}
    </nav>
    <section className="card vm-detail-content">
      {tab === 'overview' && <DetailFields rows={[
        [t('instance.detail.instanceId'), <span className="mono">{server.id}</span>],
        [t('instance.detail.status'), <StatusBadge status={server.status} />],
        [t('instance.detail.flavor'), value(specs.original_name || specs.name || specs.id)],
        [t('instance.detail.image'), image],
        [t('instance.detail.vcpu'), value(specs.vcpus)],
        [t('instance.detail.ram'), specs.ram != null ? ramGB(specs.ram) : '—'],
        [t('instance.detail.disk'), specs.disk != null ? `${specs.disk} GB` : '—'],
        [t('instance.detail.created'), fmtDate(server.created)],
        [t('instance.detail.project'), sess.project.name],
        [t('instance.detail.availabilityZone'), value(server['OS-EXT-AZ:availability_zone'])],
        [t('instance.detail.host'), value(server['OS-EXT-SRV-ATTR:host'])],
      ]} />}
      {tab === 'networking' && <><div className="vm-detail-section-head"><h3>{t('instance.detail.networkInterfaces')}</h3><div>
        <button className="btn ghost sm" onClick={() => actions.open('nic', server)}>{t('instance.detail.manageInterfaces')}</button>
        <button className="btn ghost sm" onClick={() => actions.open('fip', server)}>{t('instances.floatingIp')}</button>
        <button className="btn ghost sm" onClick={() => actions.open('sg', server)}>{t('instances.securityGroups')}</button>
      </div></div><TabState state={current} t={t} empty={tabData?.length === 0 && 'instance.detail.noInterfaces'} errorKey="instance.detail.networkError">
        <div className="vm-detail-table"><table className="tbl"><thead><tr>{['port', 'network', 'subnet', 'fixedIp', 'floatingIp', 'securityGroups', 'mac'].map((key) => <th key={key}>{t(`instance.detail.${key}`)}</th>)}</tr></thead><tbody>
          {(tabData || []).map((port) => <tr key={port.id}><td className="mono">{port.name || port.id}</td><td>{port.networkName}</td>
            <td>{port.fixed.map((item) => item.subnet).join(', ') || '—'}</td><td className="mono">{port.fixed.map((item) => item.address).join(', ') || '—'}</td>
            <td className="mono">{port.floating.join(', ') || '—'}</td><td>{port.groups.map((item) => item.name).join(', ') || '—'}</td><td className="mono">{value(port.mac_address)}</td></tr>)}
        </tbody></table></div></TabState></>}
      {tab === 'storage' && <><div className="vm-detail-section-head"><h3>{t('instance.detail.storage')}</h3><div><button className="btn ghost sm" disabled={!current.loaded} onClick={() => setAttachVolumeOpen(true)}>{t('instance.detail.attachVolume')}</button><Link className="btn ghost sm" to="/volumes">{t('instance.detail.manageVolumes')}</Link></div></div>
        <DetailFields rows={[[t('instance.detail.rootDisk'), rootDisk]]} />
        <TabState state={current} t={t} errorKey="instance.detail.storageError">
          <h4>{t('instance.detail.attachedVolumes')}</h4>
          {!tabData?.attached?.length ? <Empty>{t('instance.detail.noVolumes')}</Empty> : <div className="vm-detail-table"><table className="tbl"><thead><tr>{['name', 'volumeId', 'size', 'device', 'status'].map((key) => <th key={key}>{t(`instance.detail.${key}`)}</th>)}<th>{t('common.action')}</th></tr></thead><tbody>
            {tabData.attached.map((volume) => <tr key={volume.id}><td>{volume.name || '—'}</td><td className="mono">{volume.id}</td><td>{volume.size} GB</td><td className="mono">{value(volume.device)}</td><td><StatusBadge status={volume.status} /></td><td><ActionsMenu items={[
              { label: t('instances.snapshot'), onClick: () => snapshotVolume(volume) },
              canDetachVolume(server, volume) && { label: t('volumes.detachFromInstance'), tone: 'danger', onClick: () => detachVolume(volume) },
            ]} /></td></tr>)}
          </tbody></table></div>}
          <h4>{t('instance.detail.snapshots')}</h4>
          {tabData?.snapshotError ? <div className="vm-detail-error" role="alert">{t('instance.detail.snapshotError')} <span>{tabData.snapshotError}</span></div> : !tabData?.snapshots?.length ? <Empty>{t('instance.detail.noSnapshots')}</Empty> : <div className="vm-detail-table"><table className="tbl"><thead><tr><th>{t('instance.detail.name')}</th><th>{t('instance.detail.volumeId')}</th><th>{t('instance.detail.status')}</th></tr></thead><tbody>
            {tabData.snapshots.map((snapshot) => <tr key={snapshot.id}><td>{snapshot.name || snapshot.id}</td><td className="mono">{snapshot.volume_id}</td><td><StatusBadge status={snapshot.status} /></td></tr>)}
          </tbody></table></div>}
        </TabState></>}
      {tab === 'security' && <><div className="vm-detail-section-head"><h3>{t('instance.detail.securityGroups')}</h3><button className="btn ghost sm" onClick={() => actions.open('sg', server)}>{t('instances.securityGroups')}</button></div>
        <TabState state={current} t={t} empty={tabData?.length === 0 && 'instance.detail.noSecurityGroups'} errorKey="instance.detail.securityError">
          <div className="vm-detail-table"><table className="tbl"><thead><tr><th>{t('instance.detail.name')}</th><th>{t('instance.detail.description')}</th><th>{t('instance.detail.ruleCount')}</th></tr></thead><tbody>
            {(tabData || []).map((group) => <tr key={group.id}><td>{group.name}</td><td>{value(group.description)}</td><td>{group.security_group_rules?.length ?? 0}</td></tr>)}
          </tbody></table></div>
        </TabState></>}
      {tab === 'activity' && <><h3>{t('instance.detail.activity')}</h3><TabState state={current} t={t} empty={tabData?.length === 0 && 'instance.detail.noActivity'} errorKey="instance.detail.activityError">
        <div className="vm-detail-table"><table className="tbl"><thead><tr>{['time', 'action', 'user', 'result', 'details'].map((key) => <th key={key}>{t(`instance.detail.${key}`)}</th>)}</tr></thead><tbody>
          {(tabData || []).map((event, index) => <tr key={`${event.ts}-${index}`}><td>{fmtDate(event.ts)}</td><td>{activityLabel(t, 'action', event.action)}</td><td>{value(event.user)}</td><td>{activityLabel(t, 'result', event.result)}</td>
            <td>{event.details?.map((item) => [item.port_id, item.fixed_ip].filter(Boolean).join(' / ')).join(', ') || '—'}</td></tr>)}
        </tbody></table></div></TabState></>}
    </section>
    <InstanceActionDialogs actions={actions} />
    {attachVolumeOpen && <Modal title={t('instance.detail.attachVolume')} onClose={() => !volumeBusy && setAttachVolumeOpen(false)}
      footer={<><button className="btn ghost" disabled={volumeBusy} onClick={() => setAttachVolumeOpen(false)}>{t('common.cancel')}</button>
        <button className="btn primary" disabled={volumeBusy || !selectedVolumeId} onClick={attachVolume}>{t('volumes.attach')}</button></>}>
      {!tabData?.available?.length ? <Empty>{t('instance.detail.noAvailableVolumes')}</Empty> : <select value={selectedVolumeId} onChange={(event) => setSelectedVolumeId(event.target.value)}>
        <option value="">{t('instance.detail.selectVolume')}</option>
        {tabData.available.map((volume) => <option key={volume.id} value={volume.id}>{volume.name || volume.id} ({volume.size} GB)</option>)}
      </select>}
    </Modal>}
  </div>;
}
