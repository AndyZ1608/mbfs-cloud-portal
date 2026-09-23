import React, { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { api, fmtDate } from '../api.js';
import { Modal, Field, StatusBadge, ActionsMenu, toast, Empty, PageHead } from '../components/ui.jsx';
import { useI18n } from '../i18n/react.jsx';

const WD = ['backup.sunday', 'backup.monday', 'backup.tuesday', 'backup.wednesday', 'backup.thursday', 'backup.friday', 'backup.saturday'];
const hhmm = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
const schedText = (s, t) => s.freq === 'daily' ? t('backup.dailyAt', { time: hhmm(s.hour, s.minute) }) : t('backup.weeklyAt', { day: t(WD[s.weekday]), time: hhmm(s.hour, s.minute) });

export default function Backup() {
  const { t, locale } = useI18n();
  const [status, setStatus] = useState(null);
  const [policies, setPolicies] = useState(null);
  const [creating, setCreating] = useState(false);
  const [runningId, setRunningId] = useState(null);

  async function load() {
    try {
      const [st, po] = await Promise.all([api('/backup/status'), api('/backup/policies')]);
      setStatus(st); setPolicies(po.policies);
    } catch (e) { toast(e.message, 'error'); }
  }
  useEffect(() => { load(); }, []);

  async function toggle(p) {
    try {
      await api(`/backup/policies/${p.id}`, { method: 'PATCH', body: { enabled: !p.enabled } });
      toast(t(p.enabled ? 'backup.paused' : 'backup.enabled'), 'ok');
      load();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function runNow(p) {
    setRunningId(p.id);
    try {
      await api(`/backup/policies/${p.id}/run`, { method: 'POST' });
      toast(t('backup.runSubmitted'), 'ok');
      load();
    } catch (e) { toast(e.message, 'error'); }
    setRunningId(null);
  }

  async function del(p) {
    if (!window.confirm(t('backup.deleteConfirm', { name: p.target_name }))) return;
    try { await api(`/backup/policies/${p.id}`, { method: 'DELETE' }); toast(t('backup.deleted'), 'ok'); load(); }
    catch (e) { toast(e.message, 'error'); }
  }

  return (
    <>
      <PageHead title={t('navigation.backup')} count={policies?.length} onRefresh={load}>
        <button className="btn primary" onClick={() => setCreating(true)} disabled={status && !status.configured}><Plus size={16} /> {t('backup.createPolicy')}</button>
      </PageHead>
      <p className="dim page-desc">{t('backup.description', { timezone: status?.tz || '…' })}</p>

      {status && !status.configured && (
        <div className="card notice-card">
          {t('backup.serviceAccountMissing')} <span className="mono">.env</span>: <span className="mono">OS_TASK_USERNAME, OS_TASK_PASSWORD</span> {t('backup.serviceAccountHint')}
        </div>
      )}
      {status && status.configured && !status.persistent && (
        <div className="card notice-card">
          <b>{t('backup.warning')}:</b> {t('backup.dataNotWritable')} <span className="mono">/data</span>. {t('backup.dataVolumeHint')} <span className="mono">portal-data:/data</span>.
        </div>
      )}

      {!policies ? <Empty>{t('common.loading')}</Empty> : policies.length === 0 ? (
        <Empty>{t('backup.empty')}</Empty>
      ) : (
        <div className="card">
          <table className="tbl">
            <thead><tr><th>{t('optimize.resource')}</th><th>{t('backup.schedule')}</th><th>{t('backup.retention')}</th><th>{t('common.status')}</th><th>{t('power.lastRun')}</th><th /></tr></thead>
            <tbody>
              {policies.map((p) => (
                <tr key={p.id}>
                  <td>
                    <span className={`chip ${p.type === 'volume' ? '' : 'chip-fip'}`}>{t(p.type === 'volume' ? 'navigation.volumes' : 'navigation.instances')}</span>{' '}
                    <b>{p.target_name}</b>
                  </td>
                  <td>{schedText(p.schedule, t)}</td>
                  <td className="mono">{t('backup.copies', { count: p.retention })}</td>
                  <td>
                    <label className="check-item">
                      <input type="checkbox" checked={p.enabled} onChange={() => toggle(p)} />
                      {t(p.enabled ? 'power.enabled' : 'power.paused')}
                    </label>
                  </td>
                  <td>
                    {p.last_run ? (
                      <span title={locale === 'vi' ? p.last_run.message : t(p.last_run.status === 'ok' ? 'backup.runSucceeded' : 'backup.runFailed')}>
                        <StatusBadge status={p.last_run.status === 'ok' ? 'ACTIVE' : 'ERROR'} />{' '}
                        <span className="dim">{fmtDate(p.last_run.ts)}</span>
                      </span>
                    ) : <span className="dim">{t('power.neverRun')}</span>}
                  </td>
                  <td>
                    <ActionsMenu items={[
                      { label: t(runningId === p.id ? 'backup.running' : 'backup.runNow'), disabled: runningId === p.id || !status?.configured, onClick: () => runNow(p) },
                      'divider',
                      { label: t('backup.deletePolicy'), danger: true, onClick: () => del(p) },
                    ]} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && <CreatePolicy onClose={() => setCreating(false)} onDone={() => { setCreating(false); load(); }} />}
    </>
  );
}

function CreatePolicy({ onClose, onDone }) {
  const { t } = useI18n();
  const [targets, setTargets] = useState({ volumes: [], servers: [] });
  const [f, setF] = useState({ type: 'volume', target_id: '', freq: 'daily', weekday: 1, time: '02:00', retention: 7 });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([api('/volumes'), api('/servers')]).then(([v, s]) => {
      setTargets({ volumes: v.volumes, servers: s.servers });
      setF((x) => ({ ...x, target_id: v.volumes[0]?.id || '' }));
    }).catch((e) => toast(e.message, 'error'));
  }, []);

  const list = f.type === 'volume' ? targets.volumes : targets.servers;

  function setType(type) {
    const l = type === 'volume' ? targets.volumes : targets.servers;
    setF({ ...f, type, target_id: l[0]?.id || '' });
  }

  async function submit() {
    if (!f.target_id) return toast(t('backup.targetRequired'), 'error');
    const [hour, minute] = f.time.split(':').map(Number);
    const target = list.find((x) => x.id === f.target_id);
    setBusy(true);
    try {
      await api('/backup/policies', {
        method: 'POST',
        body: {
          type: f.type, target_id: f.target_id,
          target_name: target?.name || f.target_id.slice(0, 8),
          schedule: { freq: f.freq, hour, minute, weekday: f.freq === 'weekly' ? Number(f.weekday) : undefined },
          retention: Number(f.retention),
        },
      });
      toast(t('backup.created'), 'ok');
      onDone();
    } catch (e) { toast(e.message, 'error'); setBusy(false); }
  }

  return (
    <Modal title={t('backup.createTitle')} onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn primary" onClick={submit} disabled={busy}>{t(busy ? 'instances.creating' : 'backup.createPolicy')}</button></>}>
      <Field label={t('backup.type')}>
        <div className="tab-row" style={{ marginBottom: 0 }}>
          <button className={`tab ${f.type === 'volume' ? 'active' : ''}`} onClick={() => setType('volume')}>Snapshot volume</button>
          <button className={`tab ${f.type === 'server' ? 'active' : ''}`} onClick={() => setType('server')}>{t('backup.instanceImage')}</button>
        </div>
      </Field>
      <Field label={t(f.type === 'volume' ? 'navigation.volumes' : 'navigation.instances')}>
        <select value={f.target_id} onChange={(e) => setF({ ...f, target_id: e.target.value })}>
          {list.map((x) => <option key={x.id} value={x.id}>{x.name || x.id.slice(0, 8)}{f.type === 'volume' ? ` (${x.size} GB)` : ''}</option>)}
        </select>
        {list.length === 0 && <span className="field-hint">{t(f.type === 'volume' ? 'backup.noVolumes' : 'backup.noInstances')}</span>}
      </Field>
      <div className="row-inline">
        <Field label={t('backup.frequency')}>
          <select value={f.freq} onChange={(e) => setF({ ...f, freq: e.target.value })}>
            <option value="daily">{t('backup.daily')}</option>
            <option value="weekly">{t('backup.weekly')}</option>
          </select>
        </Field>
        {f.freq === 'weekly' && (
          <Field label={t('backup.weekday')}>
            <select value={f.weekday} onChange={(e) => setF({ ...f, weekday: e.target.value })}>
              {WD.map((key, i) => <option key={i} value={i}>{t(key)}</option>)}
            </select>
          </Field>
        )}
        <Field label={t('backup.runTime')}><input type="time" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} /></Field>
      </div>
      <Field label={t('backup.retentionCount')} hint={t('backup.retentionHint')}>
        <input type="number" min="1" max="90" value={f.retention} onChange={(e) => setF({ ...f, retention: e.target.value })} />
      </Field>
      {f.type === 'server' && <p className="dim">{t('backup.instanceHint')}</p>}
    </Modal>
  );
}
