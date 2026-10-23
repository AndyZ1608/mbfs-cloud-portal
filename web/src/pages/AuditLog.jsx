import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { toast, Empty, PageHead } from '../components/ui.jsx';
import { useI18n } from '../i18n/react.jsx';
import { formatActivity } from '../activityFormatter.js';
import { activityStatus, activityTarget, isVmActivity, vmActivityId, vmActivityName } from '../activityPresentation.js';
import ActivityTable from '../components/ActivityTable.jsx';

// Match specific method/path pairs before broad resource operations.
const RULES = [
  [/^POST \/auth\/login$/, 'login'],
  [/^POST \/auth\/logout$/, 'logout'],
  [/^POST \/auth\/switch-project$/, 'switchProject'],
  [/^JOB \/backup\/run\//, 'automatedBackup'],
  [/^POST \/backup\/policies\/[^/]+\/run$/, 'runBackup'],
  [/^POST \/backup\/policies$/, 'createBackupPolicy'],
  [/^PATCH \/backup\/policies\//, 'editBackupPolicy'],
  [/^DELETE \/backup\/policies\//, 'deleteBackupPolicy'],
  [/^POST \/servers\/[^/]+\/action$/, 'instanceAction'],
  [/^POST \/servers\/[^/]+\/console$/, 'openConsole'],
  [/^PUT \/servers\//, 'renameInstance'],
  [/^POST \/servers$/, 'createInstance'],
  [/^DELETE \/servers\//, 'deleteInstance'],
  [/^POST \/volumes\/[^/]+\/attach$/, 'attachVolume'],
  [/^POST \/volumes\/[^/]+\/detach$/, 'detachVolume'],
  [/^POST \/volumes\/[^/]+\/extend$/, 'extendVolume'],
  [/^POST \/volumes$/, 'createVolume'],
  [/^DELETE \/volumes\//, 'deleteVolume'],
  [/^POST \/snapshots$/, 'createSnapshot'],
  [/^DELETE \/snapshots\//, 'deleteSnapshot'],
  [/^POST \/images\/[^/]+\/file$/, 'uploadImageData'],
  [/^PUT \/images\/[^/]+\/file$/, 'uploadImageData'],
  [/^POST \/images\/upload$/, 'uploadImageData'],
  [/^POST \/images$/, 'createImage'],
  [/^DELETE \/images\//, 'deleteImage'],
  [/^POST \/networks$/, 'createNetwork'],
  [/^DELETE \/networks\//, 'deleteNetwork'],
  [/^POST \/routers\/[^/]+\/interfaces$/, 'attachRouterInterface'],
  [/^DELETE \/routers\/[^/]+\/interfaces\//, 'detachRouterInterface'],
  [/^POST \/routers$/, 'createRouter'],
  [/^DELETE \/routers\//, 'deleteRouter'],
  [/^POST \/floatingips\/[^/]+\/associate$/, 'associateFloatingIp'],
  [/^POST \/floatingips\/[^/]+\/disassociate$/, 'disassociateFloatingIp'],
  [/^POST \/floatingips$/, 'allocateFloatingIp'],
  [/^DELETE \/floatingips\//, 'releaseFloatingIp'],
  [/^POST \/security-group-rules$/, 'addSecurityRule'],
  [/^DELETE \/security-group-rules\//, 'deleteSecurityRule'],
  [/^POST \/security-groups$/, 'createSecurityGroup'],
  [/^DELETE \/security-groups\//, 'deleteSecurityGroup'],
  [/^POST \/keypairs$/, 'addSshKey'],
  [/^DELETE \/keypairs\//, 'deleteSshKey'],
  [/^POST \/lb\/pools\/[^/]+\/members$/, 'addLbBackend'],
  [/^DELETE \/lb\/pools\/[^/]+\/members\//, 'removeLbBackend'],
  [/^POST \/lb$/, 'createLoadBalancer'],
  [/^DELETE \/lb\//, 'deleteLoadBalancer'],
];
const NETWORK_ACTIONS = new Set([
  'network.update', 'network.rename', 'subnet.update', 'subnet.gateway.update',
  'subnet.dns.update', 'subnet.allocation_pool.update',
  'network.routing.attach', 'network.routing.detach', 'network.routing.change',
]);
const EXTERNAL_ACTIONS = new Set(['router.create', 'floating_ip.allocate', 'floating_ip.associate',
  'floating_ip.disassociate', 'floating_ip.release']);
const RESOURCE_ACTIONS = new Set(['subnet.create', 'project.create', 'project.quota.update',
  'user.create', 'user.password.reset', 'user.role.assign', 'image.upload',
  'load_balancer.create', 'load_balancer.delete', 'load_balancer.member.add',
  'load_balancer.member.delete', 'security_group.rule.add', 'security_group.rule.delete']);
const LEGACY_RESOURCE_ACTIONS = [
  [/^POST \/networks\/[^/]+\/subnet$/, 'subnet.create'],
  [/^POST \/admin\/projects$/, 'project.create'],
  [/^PUT \/admin\/projects\/[^/]+\/quota$/, 'project.quota.update'],
  [/^POST \/admin\/users$/, 'user.create'],
  [/^POST \/admin\/users\/[^/]+\/password$/, 'user.password.reset'],
  [/^POST \/admin\/assign$/, 'user.role.assign'],
];

export function networkAuditDetails(event) {
  if (event.resource_type !== 'network' || !NETWORK_ACTIONS.has(event.action)) return '';
  const details = event.details && !Array.isArray(event.details) ? event.details : {};
  if (event.action === 'network.rename' || event.action === 'subnet.update') {
    return [details.subnet_id, details.old_name && details.new_name ? `${details.old_name} → ${details.new_name}` : ''].filter(Boolean).join(' · ');
  }
  if (event.action === 'subnet.gateway.update') {
    return [details.subnet_id, `${details.old_gateway || '—'} → ${details.new_gateway || '—'}`].filter(Boolean).join(' · ');
  }
  if (event.action.startsWith('network.routing.')) {
    return [details.subnet_id, `${details.old_router_id || '—'} → ${details.new_router_id || '—'}`].filter(Boolean).join(' · ');
  }
  return details.subnet_id || '';
}

export function actionLabel(e, t) {
  if (e.action?.startsWith('auth.sso.login.') || e.path === '/auth/websso/login') return t('audit.action.login');
  if (e.action === 'auth.sso.logout') return t('audit.action.logout');
  if (e.action === 'account.password.change') return t('account.auditAction');
  if (RESOURCE_ACTIONS.has(e.action)) return t(`audit.semantic.${e.action}`);
  if (EXTERNAL_ACTIONS.has(e.action)) return t(`audit.semantic.${e.action}`);
  if (NETWORK_ACTIONS.has(e.action)) return t(`network.audit.${e.action}`);
  const formatted = formatActivity(e, t);
  if (formatted.semantic) return formatted.action === e.action ? t('audit.action.other') : formatted.action;
  const key = `${e.method} ${e.path}`;
  for (const [re, action] of LEGACY_RESOURCE_ACTIONS) if (re.test(key)) return t(`audit.semantic.${action}`);
  for (const [re, label] of RULES) if (re.test(key)) return t(`audit.action.${label}`);
  return t('audit.action.other');
}

export function filterActivityRows(entries, { query = '', resourceFilter = 'all', currentNames = {}, t }) {
  const search = query.trim().toLowerCase();
  return entries.filter((event) => {
    if (resourceFilter === 'instance' && !isVmActivity(event)) return false;
    if (!search) return true;
    const target = activityTarget(event, t, currentNames);
    return [event.user, actionLabel(event, t), target.type, target.name, activityStatus(event, t).label]
      .some((field) => (field || '').toLowerCase().includes(search));
  });
}

export default function AuditLog() {
  const { t } = useI18n();
  const [entries, setEntries] = useState(null);
  const [currentNames, setCurrentNames] = useState({});
  const [q, setQ] = useState('');
  const [resourceFilter, setResourceFilter] = useState('all');

  async function load() {
    try {
      const rows = (await api('/audit?limit=500')).entries || [];
      setEntries(rows);
      setCurrentNames({});
      // Historical names are preferred. Only unresolved VM records need a
      // current-name lookup, using the existing project-scoped VM list.
      if (rows.some((event) => isVmActivity(event) && vmActivityId(event)
        && vmActivityName(event, t) === t('activity.unknownVm'))) {
        try {
          const { servers = [] } = await api('/servers');
          setCurrentNames(Object.fromEntries(servers.map((server) => [server.id, server.name])));
        } catch { /* Unknown is safer than an unscoped or stale name. */ }
      }
    }
    catch (e) { toast(e.message, 'error'); }
  }
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    if (!entries) return null;
    return filterActivityRows(entries, { query: q, resourceFilter, currentNames, t });
  }, [entries, q, t, resourceFilter, currentNames]);

  return (
    <>
      <PageHead title={t('navigation.audit')} count={filtered?.length} onRefresh={load}>
        <select aria-label={t('audit.resourceType')} value={resourceFilter} onChange={(event) => setResourceFilter(event.target.value)}>
          <option value="all">{t('audit.allResources')}</option>
          <option value="instance">{t('audit.virtualMachines')}</option>
        </select>
        <input placeholder={t('audit.search')} value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 240 }} />
      </PageHead>
      <p className="dim page-desc">{t('audit.description')}</p>

      {!filtered ? <Empty>{t('common.loading')}</Empty> : filtered.length === 0 ? (
        <Empty>{t('audit.empty')}</Empty>
      ) : (
        <div className="card"><ActivityTable entries={filtered} actionFor={(event) => actionLabel(event, t)} currentNames={currentNames} /></div>
      )}
    </>
  );
}
