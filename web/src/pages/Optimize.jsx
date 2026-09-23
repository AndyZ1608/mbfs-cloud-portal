import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download } from 'lucide-react';
import { api } from '../api.js';
import { toast, Empty, PageHead } from '../components/ui.jsx';
import { useI18n } from '../i18n/react.jsx';

const LABEL = {
  vm_idle: 'optimize.vmIdle',
  vm_shutoff: 'optimize.vmShutoff',
  vm_error: 'optimize.vmError',
  volume_orphan: 'optimize.volumeOrphan',
  fip_idle: 'optimize.fipIdle',
  snapshot_old: 'optimize.snapshotOld',
};
const SEV = { high: ['optimize.high', 'badge-err'], medium: ['optimize.medium', 'badge-warn'], low: ['optimize.low', 'badge-muted'] };

export default function Optimize() {
  const { t } = useI18n();
  const [data, setData] = useState(null);
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);

  async function load(d = days) {
    setBusy(true);
    try { setData(await api(`/optimize?days=${d}`)); }
    catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  }
  useEffect(() => { load(); }, []); // eslint-disable-line

  function exportCsv() {
    const head = [t('optimize.type'), t('optimize.severity'), t('common.name'), t('common.details'), t('optimize.recommendation')];
    const rows = data.findings.map((f) => [LABEL[f.type] ? t(LABEL[f.type]) : f.type, t(SEV[f.severity][0]), f.name, f.detail, f.advice]);
    const csv = '\uFEFF' + [head, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `toi-uu-tai-nguyen-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <>
      <PageHead title={t('navigation.optimize')} count={data?.findings.length}>
        <span className="dim">{t('optimize.idleThreshold')}</span>
        <select value={days} onChange={(e) => { setDays(Number(e.target.value)); load(Number(e.target.value)); }} style={{ width: 110 }}>
          {[3, 7, 14, 30].map((d) => <option key={d} value={d}>{t('optimize.days', { count: d })}</option>)}
        </select>
        <button className="btn ghost" onClick={() => load()} disabled={busy}>{t(busy ? 'optimize.scanning' : 'optimize.scanAgain')}</button>
        {data?.findings.length > 0 && <button className="btn ghost" onClick={exportCsv}><Download size={15} /> CSV</button>}
      </PageHead>
      <p className="dim page-desc">{t('optimize.description')}</p>

      {!data ? <Empty>{t('optimize.scanning')}</Empty> : (
        <>
          <div className="grid-cards">
            <div className="card stat">
              <span className="stat-label">{t('optimize.totalRecommendations')}</span>
              <span className="stat-val mono">{data.findings.length}</span>
              <span className="stat-sub dim">{t('optimize.billingNote')}</span>
            </div>
            {Object.entries(data.counts).filter(([, n]) => n > 0).map(([k, n]) => (
              <div key={k} className="card stat">
                <span className="stat-label">{LABEL[k] ? t(LABEL[k]) : k}</span>
                <span className="stat-val mono">{n}</span>
              </div>
            ))}
          </div>

          {data.findings.length === 0 ? (
            <Empty>{t('optimize.noFindings')}</Empty>
          ) : (
            <div className="card">
              <table className="tbl">
                <thead><tr><th>{t('optimize.severity')}</th><th>{t('optimize.type')}</th><th>{t('optimize.resource')}</th><th>{t('common.details')}</th><th>{t('optimize.recommendation')}</th></tr></thead>
                <tbody>
                  {data.findings.map((f, i) => (
                    <tr key={f.id + i}>
                      <td><span className={`badge ${SEV[f.severity][1]}`}><i />{t(SEV[f.severity][0])}</span></td>
                      <td className="dim">{LABEL[f.type] ? t(LABEL[f.type]) : f.type}</td>
                      <td><b>{f.name}</b></td>
                      <td className="dim">{f.detail}</td>
                      <td className="dim">{f.advice}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data.monitor && !data.monitor.enabled && <div className="card notice-card">{t('optimize.monitorDisabled')} <span className="mono">OS_TASK_USERNAME/PASSWORD</span> {t('optimize.monitorPermission')}</div>}
          <p className="dim">{t('optimize.actionHint')} <Link to="/instances" className="link">{t('navigation.instances')}</Link>, <Link to="/volumes" className="link">{t('navigation.volumes')}</Link>, <Link to="/floating-ips" className="link">Floating IP</Link>.</p>
        </>
      )}
    </>
  );
}
