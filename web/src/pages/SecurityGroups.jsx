import React, { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { api } from '../api.js';
import { Modal, Field, toast, Empty, PageHead } from '../components/ui.jsx';
import { useI18n } from '../i18n/react.jsx';

export default function SecurityGroups() {
  const { t } = useI18n();
  const [groups, setGroups] = useState(null);
  const [selId, setSelId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [addingRule, setAddingRule] = useState(false);

  async function load() {
    try {
      const d = await api('/security-groups');
      setGroups(d.security_groups);
      if (d.security_groups.length && !d.security_groups.find((g) => g.id === selId)) {
        setSelId(d.security_groups[0].id);
      }
    } catch (e) { toast(e.message, 'error'); }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line

  const sel = groups?.find((g) => g.id === selId);

  async function delGroup(g) {
    if (!window.confirm(t('securityGroups.deleteConfirm', { name: g.name }))) return;
    try { await api(`/security-groups/${g.id}`, { method: 'DELETE' }); toast(t('securityGroups.deleted'), 'ok'); load(); }
    catch (e) { toast(e.message, 'error'); }
  }

  async function delRule(r) {
    try { await api(`/security-group-rules/${r.id}`, { method: 'DELETE' }); toast(t('securityGroups.ruleDeleted'), 'ok'); load(); }
    catch (e) { toast(e.message, 'error'); }
  }

  const portStr = (r) => {
    if (!r.protocol) return t('securityGroups.all');
    if (r.protocol === 'icmp') return 'ICMP';
    if (r.port_range_min == null) return t('securityGroups.all');
    return r.port_range_min === r.port_range_max ? `${r.port_range_min}` : `${r.port_range_min}–${r.port_range_max}`;
  };

  return (
    <>
      <PageHead title={t('navigation.securityGroups')} count={groups?.length} onRefresh={load}>
        <button className="btn primary" onClick={() => setCreating(true)}><Plus size={16} /> {t('securityGroups.create')}</button>
      </PageHead>

      {!groups ? <Empty>{t('common.loading')}</Empty> : (
        <div className="split">
          <div className="card split-left">
            {groups.map((g) => (
              <button key={g.id} className={`sg-item ${g.id === selId ? 'active' : ''}`} onClick={() => setSelId(g.id)}>
                <b>{g.name}</b>
                <span className="dim">{t('securityGroups.rulesCount', { count: g.security_group_rules?.length || 0 })}</span>
              </button>
            ))}
          </div>
          <div className="card split-right">
            {sel ? (
              <>
                <div className="card-head">
                  <div>
                    <h4>{sel.name}</h4>
                    {sel.description && <p className="dim">{sel.description}</p>}
                  </div>
                  <div className="page-actions">
                    <button className="btn sm" onClick={() => setAddingRule(true)}>{t('securityGroups.addRule')}</button>
                    {sel.name !== 'default' && <button className="btn sm danger-ghost" onClick={() => delGroup(sel)}>{t('securityGroups.deleteGroup')}</button>}
                  </div>
                </div>
                <table className="tbl">
                  <thead><tr><th>{t('securityGroups.direction')}</th><th>{t('securityGroups.protocol')}</th><th>{t('securityGroups.port')}</th><th>{t('securityGroups.sourceDestination')}</th><th /></tr></thead>
                  <tbody>
                    {(sel.security_group_rules || []).map((r) => (
                      <tr key={r.id}>
                        <td>{t(r.direction === 'ingress' ? 'securityGroups.ingress' : 'securityGroups.egress')}</td>
                        <td className="mono">{r.protocol || 'any'}</td>
                        <td className="mono">{portStr(r)}</td>
                        <td className="mono dim">{r.remote_ip_prefix || (r.remote_group_id ? 'group:' + r.remote_group_id.slice(0, 8) : t('securityGroups.anywhere'))}</td>
                        <td><button className="btn sm danger-ghost" onClick={() => delRule(r)}>{t('common.delete')}</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : <Empty>{t('securityGroups.selectGroup')}</Empty>}
          </div>
        </div>
      )}

      {creating && <CreateGroup onClose={() => setCreating(false)} onDone={() => { setCreating(false); load(); }} />}
      {addingRule && sel && <AddRule group={sel} onClose={() => setAddingRule(false)} onDone={() => { setAddingRule(false); load(); }} />}
    </>
  );
}

function CreateGroup({ onClose, onDone }) {
  const { t } = useI18n();
  const [f, setF] = useState({ name: '', description: '' });
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!f.name.trim()) return toast(t('securityGroups.nameRequired'), 'error');
    setBusy(true);
    try {
      await api('/security-groups', { method: 'POST', body: f });
      toast(t('securityGroups.created', { name: f.name }), 'ok');
      onDone();
    } catch (e) { toast(e.message, 'error'); setBusy(false); }
  }

  return (
    <Modal title={t('securityGroups.createTitle')} onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn primary" onClick={submit} disabled={busy}>{t('securityGroups.create')}</button></>}>
      <Field label={t('securityGroups.groupName')}><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. web-server" autoFocus /></Field>
      <Field label={t('securityGroups.description')}><input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
    </Modal>
  );
}

function AddRule({ group, onClose, onDone }) {
  const { t } = useI18n();
  const [f, setF] = useState({ direction: 'ingress', protocol: 'tcp', port_min: '', port_max: '', remote_ip_prefix: '0.0.0.0/0' });
  const [busy, setBusy] = useState(false);
  const needPorts = f.protocol === 'tcp' || f.protocol === 'udp';

  async function submit() {
    setBusy(true);
    try {
      await api('/security-group-rules', { method: 'POST', body: { ...f, security_group_id: group.id } });
      toast(t('securityGroups.ruleAdded'), 'ok');
      onDone();
    } catch (e) { toast(e.message, 'error'); setBusy(false); }
  }

  return (
    <Modal title={t('securityGroups.addRuleTitle', { name: group.name })} onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn primary" onClick={submit} disabled={busy}>{t('securityGroups.addRule')}</button></>}>
      <Field label={t('securityGroups.direction')}>
        <select value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value })}>
          <option value="ingress">{t('securityGroups.ingress')}</option>
          <option value="egress">{t('securityGroups.egress')}</option>
        </select>
      </Field>
      <Field label={t('securityGroups.protocol')}>
        <select value={f.protocol} onChange={(e) => setF({ ...f, protocol: e.target.value })}>
          <option value="tcp">TCP</option>
          <option value="udp">UDP</option>
          <option value="icmp">ICMP</option>
          <option value="any">{t('securityGroups.all')}</option>
        </select>
      </Field>
      {needPorts && (
        <div className="row-inline">
          <Field label={t('securityGroups.portFrom')}><input type="number" className="mono" value={f.port_min} onChange={(e) => setF({ ...f, port_min: e.target.value })} placeholder="e.g. 80" /></Field>
          <Field label={t('securityGroups.portTo')}><input type="number" className="mono" value={f.port_max} onChange={(e) => setF({ ...f, port_max: e.target.value })} /></Field>
        </div>
      )}
      <Field label={t('securityGroups.sourceCidr')}><input className="mono" value={f.remote_ip_prefix} onChange={(e) => setF({ ...f, remote_ip_prefix: e.target.value })} /></Field>
    </Modal>
  );
}
