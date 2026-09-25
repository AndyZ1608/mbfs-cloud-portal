import React, { useEffect, useMemo, useState } from 'react';
import { api, fmtDate } from '../api.js';
import { toast, Empty, PageHead } from '../components/ui.jsx';
import { useI18n } from '../i18n/react.jsx';
import { formatActivity } from '../activityFormatter.js';

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
function actionLabel(e, t) {
  const formatted = formatActivity(e, t);
  if (formatted.semantic) return formatted.action;
  const key = `${e.method} ${e.path}`;
  for (const [re, label] of RULES) if (re.test(key)) return t(`audit.action.${label}`);
  return key;
}

export default function AuditLog() {
  const { t } = useI18n();
  const [entries, setEntries] = useState(null);
  const [q, setQ] = useState('');
  const [resourceFilter, setResourceFilter] = useState('all');

  async function load() {
    try { setEntries((await api('/audit?limit=500')).entries); }
    catch (e) { toast(e.message, 'error'); }
  }
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    if (!entries) return null;
    const s = q.trim().toLowerCase();
    return entries.filter((e) => {
      const formatted = formatActivity(e, t);
      if (resourceFilter === 'instance' && !formatted.semantic) return false;
      if (!s) return true;
      return [e.user, actionLabel(e, t), e.path, e.resource_name, e.resource_id,
        e.project?.name, formatted.details].some((field) => (field || '').toLowerCase().includes(s));
    });
  }, [entries, q, t, resourceFilter]);

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
        <div className="card">
          <table className="tbl">
            <thead><tr><th>{t('audit.time')}</th><th>{t('audit.user')}</th><th>{t('common.action')}</th><th>{t('instance.detail.details')}</th><th>{t('audit.path')}</th><th>{t('audit.result')}</th></tr></thead>
            <tbody>
              {filtered.map((e, i) => {
                const formatted = formatActivity(e, t);
                return <tr key={e.ts + i}>
                  <td className="dim" style={{ whiteSpace: 'nowrap' }}>{fmtDate(e.ts)}</td>
                  <td><b>{e.user || '—'}</b></td>
                  <td>{actionLabel(e, t)}</td>
                  <td className="audit-details">
                    {e.resource_name && <b>{e.resource_name}</b>}
                    {e.resource_id && <span className="mono dim">{e.resource_id}</span>}
                    {formatted.details && <span>{formatted.details}</span>}
                    {e.project?.name && <small>{t('common.project')}: {e.project.name}</small>}
                    {!e.resource_name && !e.resource_id && !formatted.details && !e.project?.name && '—'}
                  </td>
                  <td className="mono dim" style={{ wordBreak: 'break-all' }}>{e.path}</td>
                  <td>
                    <span className={`badge badge-${e.result === 'failure' || e.status >= 400 ? 'err' : e.result === 'accepted' ? 'info' : 'ok'}`}><i />{formatted.result}</span>
                    <span className="dim"> {e.status}{e.ms != null ? ` · ${e.ms}ms` : ''}</span>
                  </td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
