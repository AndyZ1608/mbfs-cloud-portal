import React, { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { api, fmtDate } from '../api.js';
import { Modal, Field, StatusBadge, ActionsMenu, toast, Empty, PageHead } from '../components/ui.jsx';
import { useI18n } from '../i18n/react.jsx';

const WD = ['weekday.sun', 'weekday.mon', 'weekday.tue', 'weekday.wed', 'weekday.thu', 'weekday.fri', 'weekday.sat'];
const hhmm = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

export default function PowerSchedule() {
  const { t, locale } = useI18n();
  const [data, setData] = useState(null);
  const [creating, setCreating] = useState(false);

  async function load() {
    try { setData(await api('/power/rules')); }
    catch (e) { toast(e.message, 'error'); }
  }
  useEffect(() => { load(); }, []);

  async function toggle(r) {
    try { await api(`/power/rules/${r.id}`, { method: 'PATCH', body: { enabled: !r.enabled } }); load(); }
    catch (e) { toast(e.message, 'error'); }
  }
  async function del(r) {
    if (!window.confirm(t('power.deleteConfirm', { action: t(r.action === 'stop' ? 'instances.stop' : 'instances.start'), name: r.server_name }))) return;
    try { await api(`/power/rules/${r.id}`, { method: 'DELETE' }); toast(t('power.deleted'), 'ok'); load(); }
    catch (e) { toast(e.message, 'error'); }
  }

  return (
    <>
      <PageHead title={t('power.title')} count={data?.rules.length} onRefresh={load}>
        <button className="btn primary" onClick={() => setCreating(true)} disabled={data && !data.configured}><Plus size={16} /> {t('power.createRule')}</button>
      </PageHead>
      <p className="dim page-desc">{t('power.description', { timezone: data?.tz || '…' })}</p>

      {data && !data.configured && (
        <div className="card notice-card">
          {t('power.serviceAccountMissing')} <span className="mono">OS_TASK_USERNAME</span> / <span className="mono">OS_TASK_PASSWORD</span> {t('power.serviceAccountInstruction')} <span className="mono">.env</span>.
        </div>
      )}

      {!data ? <Empty>{t('common.loading')}</Empty> : data.rules.length === 0 ? (
        <Empty>{t('power.empty')}</Empty>
      ) : (
        <div className="card">
          <table className="tbl">
            <thead><tr><th>{t('navigation.instances')}</th><th>{t('common.action')}</th><th>{t('power.time')}</th><th>{t('power.weekdays')}</th><th>{t('common.status')}</th><th>{t('power.lastRun')}</th><th /></tr></thead>
            <tbody>
              {data.rules.map((r) => (
                <tr key={r.id}>
                  <td><b>{r.server_name}</b></td>
                  <td><span className={`chip ${r.action === 'stop' ? '' : 'chip-fip'}`}>{t(r.action === 'stop' ? 'instances.stop' : 'instances.start')}</span></td>
                  <td className="mono">{hhmm(r.schedule.hour, r.schedule.minute)}</td>
                  <td>{r.schedule.days.map((d) => <span key={d} className="chip">{t(WD[d])}</span>)}</td>
                  <td>
                    <label className="check-item">
                      <input type="checkbox" checked={r.enabled} onChange={() => toggle(r)} />{t(r.enabled ? 'power.enabled' : 'power.paused')}
                    </label>
                  </td>
                  <td>{r.last_run
                    ? <span title={locale === 'vi' ? r.last_run.message : t(r.last_run.status === 'ok' ? 'power.runSucceeded' : 'power.runFailed')}><StatusBadge status={r.last_run.status === 'ok' ? 'ACTIVE' : 'ERROR'} /> <span className="dim">{fmtDate(r.last_run.ts)}</span></span>
                    : <span className="dim">{t('power.neverRun')}</span>}</td>
                  <td><ActionsMenu items={[{ label: t('power.deleteRule'), danger: true, onClick: () => del(r) }]} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && <CreateRule onClose={() => setCreating(false)} onDone={() => { setCreating(false); load(); }} />}
    </>
  );
}

function CreateRule({ onClose, onDone }) {
  const { t } = useI18n();
  const [servers, setServers] = useState([]);
  const [f, setF] = useState({ server_id: '', preset: 'office', days: [1, 2, 3, 4, 5], stop_time: '19:00', start_time: '07:30' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/servers').then((d) => { setServers(d.servers); setF((x) => ({ ...x, server_id: d.servers[0]?.id || '' })); })
      .catch((e) => toast(e.message, 'error'));
  }, []);

  const toggleDay = (d) => setF((x) => ({ ...x, days: x.days.includes(d) ? x.days.filter((y) => y !== d) : [...x.days, d].sort() }));

  async function submit() {
    if (!f.server_id) return toast(t('power.instanceRequired'), 'error');
    if (!f.days.length) return toast(t('power.dayRequired'), 'error');
    const srv = servers.find((s) => s.id === f.server_id);
    setBusy(true);
    try {
      const mk = (action, time) => {
        const [hour, minute] = time.split(':').map(Number);
        return api('/power/rules', { method: 'POST', body: { server_id: f.server_id, server_name: srv.name, action, days: f.days, hour, minute } });
      };
      if (f.preset !== 'start_only') await mk('stop', f.stop_time);
      if (f.preset !== 'stop_only') await mk('start', f.start_time);
      toast(t('power.created'), 'ok');
      onDone();
    } catch (e) { toast(e.message, 'error'); setBusy(false); }
  }

  return (
    <Modal title={t('power.createTitle')} onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn primary" onClick={submit} disabled={busy}>{t(busy ? 'instances.creating' : 'power.createSchedule')}</button></>}>
      <Field label={t('navigation.instances')}>
        <select value={f.server_id} onChange={(e) => setF({ ...f, server_id: e.target.value })}>
          {servers.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.status})</option>)}
        </select>
      </Field>
      <Field label={t('power.scheduleType')}>
        <select value={f.preset} onChange={(e) => setF({ ...f, preset: e.target.value })}>
          <option value="office">{t('power.officeHours')}</option>
          <option value="stop_only">{t('power.stopOnly')}</option>
          <option value="start_only">{t('power.startOnly')}</option>
        </select>
      </Field>
      <div className="row-inline">
        {f.preset !== 'start_only' && <Field label={t('power.stopTime')}><input type="time" value={f.stop_time} onChange={(e) => setF({ ...f, stop_time: e.target.value })} /></Field>}
        {f.preset !== 'stop_only' && <Field label={t('power.startTime')}><input type="time" value={f.start_time} onChange={(e) => setF({ ...f, start_time: e.target.value })} /></Field>}
      </div>
      <Field label={t('power.weekdays')}>
        <div className="row-inline" style={{ flexWrap: 'wrap' }}>
          {WD.map((key, d) => (
            <button key={d} type="button" className={`preset ${f.days.includes(d) ? 'active' : ''}`} onClick={() => toggleDay(d)}>{t(key)}</button>
          ))}
        </div>
      </Field>
      <p className="dim">{t('power.shutoffHint')}</p>
    </Modal>
  );
}
