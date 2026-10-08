import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useOutletContext, useParams, useSearchParams } from 'react-router-dom';
import { api, fmtDate, ramGB, serverIps } from '../api.js';
import { ActionsMenu, Empty, Modal, StatusBadge, toast } from '../components/ui.jsx';
import { openInstanceConsole } from '../console/navigation.js';
import { useI18n } from '../i18n/react.jsx';
import useInstanceActions from '../useInstanceActions.js';
import { InstanceActionDialogs } from './Instances.jsx';
import { attachedSecurityGroups, attachedStorage, canDetachVolume, networkRows,
  resolvedInstanceFlavor, resolvedInstanceImageName } from '../instanceDetailData.js';
import { formatActivity } from '../activityFormatter.js';
import ClassificationPicker, { ClassificationChip } from '../components/ClassificationPicker.jsx';
import { emptySelection, selectionFromClassification } from '../classification.js';
import { instanceErrorCategory, instanceErrorDescription, instanceErrorGuidance,
  instanceErrorTitle, safeInstanceErrorCode, safeVolumeContext } from '../instanceError.js';
import { canExtendVolume } from '../../../shared/volumeExtend.mjs';
import useVolumeExtend from '../useVolumeExtend.js';
import { PortVipsModal } from '../components/VipModals.jsx';

const VmMonitoringTab = React.lazy(() => import('../components/VmMonitoringTab.jsx'));
const BASE_TABS = ['overview', 'networking', 'storage', 'security', 'activity'];
export const detailTabs = (monitoringEnabled) => monitoringEnabled
  ? ['overview', 'networking', 'storage', 'security', 'monitoring', 'activity'] : BASE_TABS;
const value = (item) => item === undefined || item === null || item === '' ? '—' : item;

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

function DetailCrashFallback({ onRetry }) {
  const { t } = useI18n();
  return <div className="vm-detail-error" role="alert">{t('instance.detail.displayFailed')}
    <div><button className="btn ghost" onClick={onRetry}>{t('common.retry')}</button>
      <Link className="btn ghost" to="/instances">{t('navigation.instances')}</Link></div>
  </div>;
}

class DetailErrorBoundary extends React.Component {
  state = { failed: false, attempt: 0 };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <DetailCrashFallback onRetry={() => this.setState((state) => ({ failed: false, attempt: state.attempt + 1 }))} />;
    return <React.Fragment key={this.state.attempt}>{this.props.children}</React.Fragment>;
  }
}

export default function InstanceDetailRoute() {
  const { instanceId } = useParams();
  const { t } = useI18n();
  const { sess, config } = useOutletContext() || {};
  const currentProjectId = sess?.project?.id ?? null;
  if (!sess) return <Empty>{t('common.loading')}</Empty>;
  if (!currentProjectId) return <Empty>{t('common.loading')}</Empty>;
  // The key discards every instance-scoped state value on route or project change.
  return <DetailErrorBoundary key={`${instanceId}:${currentProjectId}`}>
    <InstanceDetail instanceId={instanceId} project={sess.project} roles={sess.roles}
      monitoringEnabled={config?.monitoringEnabled === true} />
  </DetailErrorBoundary>;
}

function InstanceDetail({ instanceId, project, roles, monitoringEnabled }) {
  const { t } = useI18n();
  const currentProjectId = project.id;
  const canAssign = roles?.some((role) => ['member', 'admin'].includes(role));
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tabs = detailTabs(monitoringEnabled);
  const tab = tabs.includes(params.get('tab')) ? params.get('tab') : 'overview';
  const [server, setServer] = useState(null);
  const [serverError, setServerError] = useState(null);
  const [failure, setFailure] = useState({ loading: false, error: null, data: null });
  const [serverRevision, setServerRevision] = useState(0);
  const [tabRevision, setTabRevision] = useState(0);
  const [tabStates, setTabStates] = useState({});
  const [resolvedImage, setResolvedImage] = useState(null);
  const [flavor, setFlavor] = useState(null);
  const [attachVolumeOpen, setAttachVolumeOpen] = useState(false);
  const [vipPortId, setVipPortId] = useState(null);
  const [selectedVolumeId, setSelectedVolumeId] = useState('');
  const [volumeBusy, setVolumeBusy] = useState(false);
  const [activityMoreBusy, setActivityMoreBusy] = useState(false);
  const [editLabelsTags, setEditLabelsTags] = useState(false);
  const [labelsTagsBusy, setLabelsTagsBusy] = useState(false);
  const [labelsTagsLoading, setLabelsTagsLoading] = useState(false);
  const [labelsTagsLoadFailed, setLabelsTagsLoadFailed] = useState(false);
  const [classificationCatalog, setClassificationCatalog] = useState(null);
  const [classificationSelection, setClassificationSelection] = useState(emptySelection);
  const [labelsTagsError, setLabelsTagsError] = useState('');
  const current = tabStates[tab] || {};
  const encodedId = encodeURIComponent(instanceId);
  const volumeExtend = useVolumeExtend({ volumes: tab === 'storage' ? current.data?.attached : [],
    onRefresh: refresh, enabled: tab === 'storage' });

  function refresh() {
    setServerRevision((n) => n + 1);
    setTabRevision((n) => n + 1);
  }
  const actions = useInstanceActions({ onChanged: refresh, onDeleted: () => navigate('/instances') });

  useEffect(() => {
    if (!currentProjectId) return;
    let live = true;
    api(`/servers/${encodedId}`).then(({ server: next }) => {
      if (!live) return;
      if (!next || next.id !== instanceId) throw new Error('Invalid instance response');
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
  }, [encodedId, instanceId, currentProjectId, serverRevision]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const timer = setInterval(() => setServerRevision((n) => n + 1), 10000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!currentProjectId) return;
    if (server?.status !== 'ERROR') {
      setFailure({ loading: false, error: null, data: null });
      return;
    }
    let live = true;
    setFailure((previous) => ({ loading: true, error: null,
      data: previous.data?.code === server.instance_error?.code ? previous.data : null }));
    api(`/servers/${encodedId}/error`).then(({ error }) => {
      if (live) setFailure({ loading: false, error: null, data: error });
    }).catch(() => {
      if (live) setFailure({ loading: false, error: true, data: null });
    });
    return () => { live = false; };
  }, [server?.id, server?.status, serverRevision, encodedId, currentProjectId]);

  useEffect(() => {
    if (!server || !currentProjectId) return;
    let live = true;
    if (server.flavor?.vcpus == null) {
      api('/flavors').then(({ flavors }) => {
        if (live) setFlavor(Array.isArray(flavors) ? flavors.find((item) => item.id === server.flavor?.id) || null : null);
      }).catch(() => {});
    }
    if (server.image?.id) {
      api('/images').then(({ images }) => {
        if (live) setResolvedImage({ id: server.image.id,
          name: Array.isArray(images) ? images.find((item) => item.id === server.image.id)?.name || null : null });
      }).catch(() => {});
    }
    return () => { live = false; };
  }, [server?.id, server?.image?.id, server?.flavor?.id, currentProjectId]);

  useEffect(() => {
    if (!server || !currentProjectId || tab === 'overview' || tab === 'monitoring') return;
    let live = true;
    setTabStates((states) => ({ ...states, [tab]: { ...states[tab], loading: true, error: null } }));
    const loaders = {
      networking: async () => {
        const [ports, networks, fips, groups, vipView] = await Promise.all([
          api(`/servers/${encodedId}/interfaces`), api('/available-networks'),
          api('/floatingips'), api('/security-groups'), api(`/servers/${encodedId}/vips`).catch((error) => ({ error: error.message })),
        ]);
        const byPort = new Map((vipView.ports || []).map((item) => [item.id, item]));
        return networkRows(ports.interfaces, networks.networks, fips.floatingips, groups.security_groups)
          .map((port) => ({ ...port, vipView: byPort.get(port.id) || null, vipLoadError: vipView.error || null }));
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
      activity: async () => api(`/servers/${encodedId}/activity?limit=50`),
    };
    loaders[tab]().then((data) => {
      if (live) setTabStates((states) => ({ ...states, [tab]: { loaded: true, loading: false, data } }));
    }).catch((error) => {
      if (live) setTabStates((states) => ({ ...states, [tab]: { loaded: false, loading: false, error: error.message } }));
    });
    return () => { live = false; };
  }, [server?.id, tab, tabRevision, encodedId, currentProjectId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (serverError) return <div className="vm-detail-error" role="alert">
    {t([403, 404].includes(serverError.status) ? 'instance.detail.unavailable' : 'instance.detail.displayFailed')}
    <div><Link className="btn ghost" to="/instances">{t('navigation.instances')}</Link>
      <button className="btn ghost" onClick={refresh}>{t('common.retry')}</button></div></div>;
  if (!server) return <Empty>{t('common.loading')}</Empty>;

  const activeError = failure.data || server.instance_error;
  const volumeContext = activeError?.code === 'IMAGE_SIZE_EXCEEDS_VOLUME' ? safeVolumeContext(activeError.context) : null;
  const supportReference = /^req-(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{8,64})$/i.test(failure.data?.request_id || '')
    ? failure.data.request_id : null;
  const resolvedImageName = resolvedInstanceImageName(server.image, resolvedImage);
  const errorImageName = failure.data?.image_name || resolvedImageName;
  const specs = resolvedInstanceFlavor(server.flavor, flavor);
  const ips = serverIps(server);
  const tabData = current.data;
  const bootFromVolume = !server.image?.id && Array.isArray(server['os-extended-volumes:volumes_attached'])
    && server['os-extended-volumes:volumes_attached'].length > 0;
  const image = server.image?.id ? (resolvedImageName || server.image.id)
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
  async function loadMoreActivity() {
    if (activityMoreBusy || tabData?.next_offset == null) return;
    setActivityMoreBusy(true);
    try {
      const next = await api(`/servers/${encodedId}/activity?limit=50&offset=${tabData.next_offset}`);
      setTabStates((states) => ({ ...states, activity: { ...states.activity,
        data: { entries: [...(states.activity?.data?.entries || []), ...(next.entries || [])],
          next_offset: next.next_offset } } }));
    } catch (error) { toast(error.message, 'error'); }
    finally { setActivityMoreBusy(false); }
  }
  async function openLabelsTags() {
    setEditLabelsTags(true);
    setLabelsTagsLoading(true);
    setLabelsTagsLoadFailed(false);
    setClassificationCatalog(null);
    setClassificationSelection(emptySelection());
    setLabelsTagsError('');
    try {
      const [catalog, current] = await Promise.all([
        api('/classifications/catalog'), api(`/servers/${encodedId}/classifications`),
      ]);
      setClassificationCatalog(catalog);
      setClassificationSelection(selectionFromClassification(current.classification));
    } catch (error) { setLabelsTagsError(error.message); setLabelsTagsLoadFailed(true); }
    finally { setLabelsTagsLoading(false); }
  }
  async function saveLabelsTags() {
    if (labelsTagsBusy) return;
    setLabelsTagsBusy(true);
    setLabelsTagsError('');
    try {
      await api(`/servers/${encodedId}/classifications`, { method: 'PUT', body: classificationSelection });
      setEditLabelsTags(false);
      toast(t('instance.classification.updated'), 'ok');
      refresh();
    } catch (error) {
      setLabelsTagsError(error.message);
    }
    finally { setLabelsTagsBusy(false); }
  }
  const labels = Array.isArray(server.classification?.labels)
    ? server.classification.labels.filter((item) => item && typeof item === 'object') : [];
  const tags = Array.isArray(server.classification?.tags)
    ? server.classification.tags.filter((item) => item && typeof item === 'object') : [];
  return <div className="vm-detail-page">
    <nav className="vm-detail-breadcrumb" aria-label={t('instance.detail.breadcrumb')}>
      <Link to="/instances">{t('navigation.compute')} / {t('navigation.instances')}</Link><span> / {server.name}</span>
    </nav>
    <div className="vm-detail-header card">
      <div className="vm-detail-heading"><div><h2>{server.name}</h2><div className="vm-detail-identity"><StatusBadge status={server.status} /><span className="mono">{server.id}</span></div></div>
        <div className="vm-detail-actions"><button className="btn primary" onClick={() => openInstanceConsole(server.id)}>{t('instance.detail.openConsole')}</button>
          <ActionsMenu items={actions.items(server)} /><button className="btn ghost" onClick={refresh}>{t('common.refresh')}</button></div></div>
      <div className="vm-detail-summary">
        <span>{t('instance.detail.project')}: <b>{value(project.name)}</b></span>
        <span>{t('instance.detail.flavor')}: <b>{value(specs.original_name || specs.name || specs.id)}</b></span>
        <span>{t('instance.detail.created')}: <b>{fmtDate(server.created)}</b></span>
        <span>{t('instance.detail.ipAddresses')}: <b>{ips.map((item) => item.ip).join(', ') || '—'}</b></span>
      </div>
      {server.status === 'ERROR' && <div className="vm-error-banner" role="alert">
        <div><strong>{t('instance.error.header')}</strong><span>{failure.error ? t('instance.error.loadFailed') : instanceErrorTitle(t, activeError?.code)}</span></div>
        <button className="btn ghost sm" onClick={() => setParams({})}>{t('instance.error.viewDetails')}</button>
      </div>}
    </div>
    <nav className="vm-detail-tabs" aria-label={t('instance.detail.tabs')}>
      {tabs.map((key) => <button key={key} className={tab === key ? 'active' : ''} aria-current={tab === key ? 'page' : undefined}
        onClick={() => setParams(key === 'overview' ? {} : { tab: key })}>{t(`instance.detail.${key}`)}</button>)}
    </nav>
    <section className="card vm-detail-content">
      {tab === 'overview' && <>{server.status === 'ERROR' && <div className="vm-error-card" role="region" aria-label={t('instance.error.details')}>
        <h3>{t('instance.error.details')}</h3>
        {failure.loading && !failure.data && <p>{t('common.loading')}</p>}
        {failure.error && <p>{t('instance.error.loadFailed')}</p>}
        {!failure.error && activeError && <>
          <div className="vm-error-fields">
            <div><span>{t('instance.error.type')}</span><strong>{t(`instance.error.category.${instanceErrorCategory(activeError.code)}`)}</strong></div>
            <div><span>{t('instance.error.reason')}</span><strong>{instanceErrorTitle(t, activeError.code)}</strong></div>
            <div><span>{t('instance.error.description')}</span><p>{instanceErrorDescription(t, activeError)}</p></div>
            {volumeContext && <><div><span>{t('instance.error.requiredDisk')}</span><strong>{volumeContext.required_disk_gb} GB</strong></div>
              <div><span>{t('instance.error.bootVolume')}</span><strong>{volumeContext.requested_volume_gb} GB</strong></div></>}
            {activeError.code === 'IMAGE_SIZE_EXCEEDS_VOLUME' && errorImageName && <div><span>{t('instance.detail.image')}</span><strong>{errorImageName}</strong></div>}
            <div><span>{t('instance.error.suggestedActions')}</span><p>{instanceErrorGuidance(t, activeError.code, activeError.context)}</p></div>
            <div><span>{t('instance.error.code')}</span><code>{safeInstanceErrorCode(activeError.code)}</code></div>
            {supportReference && <div><span>{t('instance.error.supportReference')}</span><code>{supportReference}</code></div>}
          </div>
          {failure.data?.occurred_at && <small>{t('instance.error.occurredAt')}: {fmtDate(failure.data.occurred_at)}</small>}
        </>}
      </div>}<DetailFields rows={[
        [t('instance.detail.instanceId'), <span className="mono">{server.id}</span>],
        [t('instance.detail.status'), <StatusBadge status={server.status} />],
        [t('instance.detail.flavor'), value(specs.original_name || specs.name || specs.id)],
        [t('instance.detail.image'), image],
        [t('instance.detail.vcpu'), value(specs.vcpus)],
        [t('instance.detail.ram'), specs.ram != null ? ramGB(specs.ram) : '—'],
        [t('instance.detail.disk'), specs.disk != null ? `${specs.disk} GB` : '—'],
        [t('instance.detail.created'), fmtDate(server.created)],
        [t('instance.detail.project'), value(project.name)],
        [t('instance.detail.availabilityZone'), value(server['OS-EXT-AZ:availability_zone'])],
        [t('instance.detail.host'), value(server['OS-EXT-SRV-ATTR:host'])],
      ]} />
        <div className="vm-detail-labels-tags">
          <div className="vm-detail-section-head"><h3>{t('instance.classification.title')}</h3>
            {canAssign && <button className="btn ghost sm" onClick={openLabelsTags}>{t('instance.classification.manage')}</button>}</div>
          {!labels.length && !tags.length ? <p className="dim">{t('instance.classification.none')}</p> : <>
            {labels.length > 0 && <div className="classification-display-group"><h4>{t('classification.labels')}</h4>
              <div className="classification-chips">{labels.map((item) => <ClassificationChip key={item.label_id}
                text={`${item.label_name}: ${item.value}`} color={item.color} />)}</div></div>}
            {tags.length > 0 && <div className="classification-display-group"><h4>{t('classification.tags')}</h4>
              <div className="classification-chips">{tags.map((item) => <ClassificationChip key={item.id}
                text={item.name} color={item.color} />)}</div></div>}
          </>}
        </div></>}
      {tab === 'networking' && <><div className="vm-detail-section-head"><h3>{t('instance.detail.networkInterfaces')}</h3><div>
        <button className="btn ghost sm" onClick={() => actions.open('nic', server)}>{t('instance.detail.manageInterfaces')}</button>
        <button className="btn ghost sm" onClick={() => actions.open('fip', server)}>{t('instances.floatingIp')}</button>
        <button className="btn ghost sm" onClick={() => actions.open('sg', server)}>{t('instances.securityGroups')}</button>
      </div></div><TabState state={current} t={t} empty={tabData?.length === 0 && 'instance.detail.noInterfaces'} errorKey="instance.detail.networkError">
        <div className="vm-detail-table"><table className="tbl"><thead><tr>{['port', 'network', 'subnet', 'fixedIp', 'floatingIp', 'securityGroups', 'mac'].map((key) => <th key={key}>{t(`instance.detail.${key}`)}</th>)}<th>{t('instance.networking.allowedAddressPairs')}</th><th>{t('common.action')}</th></tr></thead><tbody>
          {(tabData || []).map((port) => <tr key={port.id}><td className="mono">{port.name || port.id}</td><td>{port.networkName}</td>
            <td>{port.fixed.map((item) => item.subnet).join(', ') || '—'}</td><td className="mono">{port.fixed.map((item) => item.address).join(', ') || '—'}</td>
            <td className="mono">{port.floating.join(', ') || '—'}</td><td>{port.groups.map((item) => item.name).join(', ') || '—'}</td><td className="mono">{value(port.mac_address)}</td>
            <td>{port.vipView ? <div className="vip-pair-list">
              {port.vipView.vips.map((vip) => <span key={vip.id}><strong>{vip.name || vip.id}</strong> <span className="mono">{vip.ip_address}</span></span>)}
              {port.vipView.external_pairs.map((pair, index) => <span key={`${pair.ip_address}-${index}`}><small>{t('instance.networking.externalAddressPair')}</small> <span className="mono">{pair.ip_address}</span></span>)}
              {!port.vipView.vips.length && !port.vipView.external_pairs.length && '—'}
            </div> : <span className="mono">{port.allowed_address_pairs?.map((pair) => pair.ip_address).join(', ') || '—'}</span>}</td>
            <td>{port.vipView?.manageable && <button className="btn ghost sm" onClick={() => setVipPortId(port.id)}>{t('instance.networking.manageVips')}</button>}</td></tr>)}
        </tbody></table></div></TabState></>}
      {tab === 'storage' && <><div className="vm-detail-section-head"><h3>{t('instance.detail.storage')}</h3><div><button className="btn ghost sm" disabled={!current.loaded} onClick={() => setAttachVolumeOpen(true)}>{t('instance.detail.attachVolume')}</button><Link className="btn ghost sm" to="/volumes">{t('instance.detail.manageVolumes')}</Link></div></div>
        <DetailFields rows={[[t('instance.detail.rootDisk'), rootDisk]]} />
        <TabState state={current} t={t} errorKey="instance.detail.storageError">
          <h4>{t('instance.detail.attachedVolumes')}</h4>
          {!tabData?.attached?.length ? <Empty>{t('instance.detail.noVolumes')}</Empty> : <div className="vm-detail-table"><table className="tbl"><thead><tr>{['name', 'volumeId', 'size', 'device', 'status'].map((key) => <th key={key}>{t(`instance.detail.${key}`)}</th>)}<th>{t('common.action')}</th></tr></thead><tbody>
            {tabData.attached.map((volume) => <tr key={volume.id}><td>{volume.name || '—'}</td><td className="mono">{volume.id}</td><td>{volume.size} GB</td><td className="mono">{value(volume.device)}</td><td><StatusBadge status={volume.status} /></td><td><ActionsMenu items={[
              canExtendVolume(volume.status) && { label: t('volumes.extend'), disabled: volumeExtend.isPending(volume.id),
                onClick: () => volumeExtend.extend(volume) },
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
      {tab === 'monitoring' && <React.Suspense fallback={<Empty>{t('monitoring.loading')}</Empty>}>
        <VmMonitoringTab projectId={currentProjectId} instanceId={instanceId} />
      </React.Suspense>}
      {tab === 'activity' && <><h3>{t('instance.detail.activity')}</h3><TabState state={current} t={t} empty={tabData?.entries?.length === 0 && 'instance.detail.noActivity'} errorKey="instance.detail.activityError">
        <div className="vm-detail-table"><table className="tbl"><thead><tr>{['time', 'action', 'user', 'result', 'details'].map((key) => <th key={key}>{t(`instance.detail.${key}`)}</th>)}</tr></thead><tbody>
          {(tabData?.entries || []).map((event, index) => {
            const formatted = formatActivity(event, t);
            return <tr key={`${event.ts}-${index}`}><td>{fmtDate(event.ts)}</td><td>{formatted.action || value(event.action)}</td><td>{value(event.user)}</td><td>{formatted.result}</td>
              <td>{formatted.details || '—'}</td></tr>;
          })}
        </tbody></table></div>
        {tabData?.next_offset != null && <button className="btn ghost sm" disabled={activityMoreBusy} onClick={loadMoreActivity}>{t('instance.detail.loadMore')}</button>}
      </TabState></>}
    </section>
    <InstanceActionDialogs actions={actions} />
    {vipPortId && <PortVipsModal portId={vipPortId} onClose={() => setVipPortId(null)}
      onDone={() => { setVipPortId(null); refresh(); }} />}
    {editLabelsTags && <Modal title={t('instance.classification.title')} wide onClose={() => !labelsTagsBusy && setEditLabelsTags(false)}
      footer={<><button className="btn ghost" disabled={labelsTagsBusy} onClick={() => setEditLabelsTags(false)}>{t('common.cancel')}</button>
        <button className="btn primary" disabled={labelsTagsBusy || labelsTagsLoading || labelsTagsLoadFailed}
          onClick={saveLabelsTags}>{t(labelsTagsBusy ? 'instance.labelsTags.saving' : 'instance.labelsTags.save')}</button></>}>
      {labelsTagsLoading ? <Empty>{t('common.loading')}</Empty> : classificationCatalog && <ClassificationPicker
        catalog={classificationCatalog} selection={classificationSelection} onChange={setClassificationSelection} disabled={labelsTagsBusy} />}
      {labelsTagsError && <p className="err-text" role="alert">{labelsTagsError}</p>}
    </Modal>}
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
