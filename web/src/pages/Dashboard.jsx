import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDate, ramGB, serverIps } from '../api.js';
import { StatusBadge, UsageBar, Empty } from '../components/ui.jsx';
import { FileCode } from 'lucide-react';
import { useI18n } from '../i18n/react.jsx';

export default function Dashboard() {
  const { t } = useI18n();
  const [limits, setLimits] = useState(null);
  const [servers, setServers] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    Promise.all([api('/limits'), api('/servers')])
      .then(([l, s]) => { setLimits(l); setServers(s.servers); })
      .catch((e) => setErr(e.message));
  }, []);

  if (err) return <Empty>{t('common.loadFailed', { message: err })}</Empty>;
  if (!limits || !servers) return <Empty>{t('common.loading')}</Empty>;

  const c = limits.compute || {};
  const v = limits.volume || {};
  const n = limits.network || {};
  const byStatus = servers.reduce((a, s) => ((a[s.status] = (a[s.status] || 0) + 1), a), {});
  const recent = [...servers].sort((a, b) => new Date(b.created) - new Date(a.created)).slice(0, 5);

  return (
    <>
      <div className="page-head"><h2>{t('navigation.overview')}</h2>
        <div className="page-actions">
          <a className="btn ghost" href="/api/export/terraform"><FileCode size={15} /> {t('dashboard.exportTerraform')}</a>
        </div>
      </div>

      <div className="grid-cards">
        <div className="card">
          <h4>{t('dashboard.computeQuota')}</h4>
          <UsageBar label={t('navigation.instances')} used={c.totalInstancesUsed ?? 0} max={c.maxTotalInstances ?? 0} />
          <UsageBar label="vCPU" used={c.totalCoresUsed ?? 0} max={c.maxTotalCores ?? 0} />
          <UsageBar label="RAM" used={c.totalRAMUsed ?? 0} max={c.maxTotalRAMSize ?? 0} render={(x) => ramGB(x)} />
        </div>
        <div className="card">
          <h4>{t('dashboard.storageQuota')}</h4>
          <UsageBar label={t('dashboard.volumeCapacity')} used={v.totalGigabytesUsed ?? 0} max={v.maxTotalVolumeGigabytes ?? 0} unit="GB" />
          <UsageBar label={t('dashboard.volumeCount')} used={v.totalVolumesUsed ?? 0} max={v.maxTotalVolumes ?? 0} />
          {v.maxTotalSnapshots != null && <UsageBar label="Snapshot" used={v.totalSnapshotsUsed ?? 0} max={v.maxTotalSnapshots} />}
        </div>
        <div className="card">
          <h4>{t('dashboard.networkQuota')}</h4>
          {n.floatingip ? (
            <>
              <UsageBar label="Floating IP" used={n.floatingip.used ?? 0} max={n.floatingip.limit ?? 0} />
              {n.network && <UsageBar label="Network" used={n.network.used ?? 0} max={n.network.limit ?? 0} />}
              {n.security_group && <UsageBar label="Security group" used={n.security_group.used ?? 0} max={n.security_group.limit ?? 0} />}
            </>
          ) : (
            <p className="dim">{t('dashboard.neutronQuotaUnavailable')}</p>
          )}
        </div>
        <div className="card">
          <h4>{t('dashboard.instanceStatus')}</h4>
          <div className="status-chips">
            {Object.keys(byStatus).length === 0 && <p className="dim">{t('dashboard.noInstances')}</p>}
            {Object.entries(byStatus).map(([st, cnt]) => (
              <div key={st} className="status-chip"><StatusBadge status={st} /><b>{cnt}</b></div>
            ))}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h4>{t('dashboard.recentInstances')}</h4>
          <Link to="/instances" className="link">{t('dashboard.viewAll')}</Link>
        </div>
        {recent.length === 0 ? (
          <Empty>{t('dashboard.noInstancesAction')} <Link to="/instances" className="link">{t('navigation.instances')}</Link>.</Empty>
        ) : (
          <table className="tbl">
            <thead><tr><th>{t('common.name')}</th><th>{t('common.status')}</th><th>{t('common.ipAddress')}</th><th>{t('instances.flavor')}</th><th>{t('common.createdAt')}</th></tr></thead>
            <tbody>
              {recent.map((s) => (
                <tr key={s.id}>
                  <td><b>{s.name}</b></td>
                  <td><StatusBadge status={s.status} /></td>
                  <td>{serverIps(s).map((x) => <span key={x.ip} className="mono chip">{x.ip}</span>)}</td>
                  <td className="dim">{s.flavor?.original_name || s.flavor?.id || '—'}</td>
                  <td className="dim">{fmtDate(s.created)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
