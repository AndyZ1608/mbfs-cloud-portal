import React, { useEffect, useRef, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api, fmtDate } from '../api.js';
import { Empty, Modal, PageHead, toast } from '../components/ui.jsx';
import TypeToConfirmDialog from '../components/TypeToConfirmDialog.jsx';
import { ClassificationChip, ColorPicker } from '../components/ClassificationPicker.jsx';
import { useI18n } from '../i18n/react.jsx';

const NEW_COLOR = '#64748B'; // Neutral picker default, never a business classification.
const blankLabel = () => ({ name: '', description: '', values: [{ value: '', color: NEW_COLOR }] });
const blankTag = () => ({ name: '', description: '', color: NEW_COLOR });

export default function LabelsTagsRoute() {
  const { sess } = useOutletContext();
  return <LabelsTags key={sess.project.id} sess={sess} />;
}

function LabelsTags({ sess }) {
  const { t } = useI18n();
  const canManage = sess.roles?.some((role) => ['member', 'admin'].includes(role));
  const projectRef = useRef(sess.project.id);
  projectRef.current = sess.project.id;
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('labels');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    try {
      const result = await api('/classifications/catalog');
      if (projectRef.current === sess.project.id) setData(result);
    } catch (failure) { if (projectRef.current === sess.project.id) toast(failure.message, 'error'); }
  }
  useEffect(() => { setData(null); setEditing(null); setDeleting(null); load(); }, [sess.project.id]); // eslint-disable-line react-hooks/exhaustive-deps

  function open(kind, item = null) {
    setEditing({ kind, item });
    setDraft(item ? structuredClone(item) : kind === 'label' ? blankLabel() : blankTag());
    setError('');
  }

  async function save() {
    if (busy) return;
    const kind = editing.kind;
    let payload = { ...draft };
    if (kind === 'label' && editing.item) {
      const old = editing.item.values;
      const kept = new Set(draft.values.map((item) => item.id));
      const impacted = old.filter((item) => !kept.has(item.id)).reduce((n, item) => n + item.assignment_count, 0);
      if (impacted && !window.confirm(t('classification.removeValuesConfirm', { count: impacted }))) return;
      payload = { ...payload, confirm_removals: impacted > 0 };
    }
    setBusy(true); setError('');
    try {
      const path = editing.item ? `/classifications/${kind === 'label' ? 'labels' : 'tags'}/${encodeURIComponent(editing.item.id)}`
        : `/classifications/${kind === 'label' ? 'labels' : 'tags'}`;
      await api(path, { method: editing.item ? 'PATCH' : 'POST', body: payload });
      setEditing(null); await load(); toast(t('classification.saved'), 'ok');
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }

  async function confirmDelete() {
    if (!deleting || busy) return;
    setBusy(true);
    try {
      await api(`/classifications/${deleting.kind === 'label' ? 'labels' : 'tags'}/${encodeURIComponent(deleting.item.id)}`,
        { method: 'DELETE', body: { confirm: true } });
      setDeleting(null); await load(); toast(t('classification.deleted'), 'ok');
    } catch (failure) { toast(failure.message, 'error'); }
    finally { setBusy(false); }
  }

  const query = search.trim().toLocaleLowerCase();
  const labels = (data?.labels || []).filter((item) => !query || item.name.toLocaleLowerCase().includes(query)
    || item.values.some((value) => value.value.toLocaleLowerCase().includes(query)));
  const tags = (data?.tags || []).filter((item) => !query || item.name.toLocaleLowerCase().includes(query));
  return <div className="classification-page">
    <PageHead title={t('classification.title')} onRefresh={load}>
      <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('classification.search')} />
    </PageHead>
    <div className="vm-detail-tabs" role="tablist">
      {['labels', 'tags'].map((kind) => <button key={kind} role="tab" aria-selected={tab === kind}
        className={tab === kind ? 'active' : ''} onClick={() => setTab(kind)}>{t(`classification.${kind}`)}</button>)}
    </div>
    {!data ? <Empty>{t('common.loading')}</Empty> : !data.labels.length && !data.tags.length ?
      <div className="card classification-empty"><h3>{t('classification.emptyTitle')}</h3><p>{t('classification.emptyDescription')}</p>
        {canManage && <><button className="btn primary" onClick={() => open('label')}>{t('classification.labels.create')}</button>
          <button className="btn ghost" onClick={() => open('tag')}>{t('classification.tags.create')}</button></>}</div>
      : <section className="card">
        <div className="vm-detail-section-head"><h3>{t(`classification.${tab}`)}</h3>
          {canManage && <button className="btn primary sm" onClick={() => open(tab === 'labels' ? 'label' : 'tag')}>
            {t(tab === 'labels' ? 'classification.labels.create' : 'classification.tags.create')}</button>}</div>
        {tab === 'labels' ? !labels.length ? <Empty>{t('classification.noLabels')}</Empty> : labels.map((item) =>
          <article className="classification-row" key={item.id}>
            <div><h4>{item.name}</h4>{item.description && <p className="dim">{item.description}</p>}
              <div className="vm-tag-chips">{item.values.map((value) => <ClassificationChip key={value.id} text={value.value}
                title={`${item.name}: ${value.value}`} color={value.color} />)}</div>
              <small className="dim">{t('classification.assignedInstances')}: {item.assignment_count} · {t('classification.updated')}: {fmtDate(item.updated_at)}</small></div>
            {canManage && <div className="classification-row-actions"><button className="btn ghost sm" onClick={() => open('label', item)}>{t('common.edit')}</button>
              <button className="btn danger-ghost sm" onClick={() => setDeleting({ kind: 'label', item })}>{t('common.delete')}</button></div>}
          </article>)
          : !tags.length ? <Empty>{t('classification.noTags')}</Empty> : tags.map((item) =>
            <article className="classification-row" key={item.id}>
              <div><ClassificationChip text={item.name} color={item.color} />{item.description && <p className="dim">{item.description}</p>}
                <small className="dim">{t('classification.assignedInstances')}: {item.assignment_count} · {t('classification.updated')}: {fmtDate(item.updated_at)}</small></div>
              {canManage && <div className="classification-row-actions"><button className="btn ghost sm" onClick={() => open('tag', item)}>{t('common.edit')}</button>
                <button className="btn danger-ghost sm" onClick={() => setDeleting({ kind: 'tag', item })}>{t('common.delete')}</button></div>}
            </article>)}
      </section>}
    {editing && <Modal title={t(editing.item ? editing.kind === 'label' ? 'classification.labels.edit' : 'classification.tags.edit'
      : editing.kind === 'label' ? 'classification.labels.create' : 'classification.tags.create')}
      onClose={() => !busy && setEditing(null)} wide footer={<><button className="btn ghost" disabled={busy} onClick={() => setEditing(null)}>{t('common.cancel')}</button>
        <button className="btn primary" disabled={busy} onClick={save}>{t('common.save')}</button></>}>
      <div className="classification-form"><label>{t(editing.kind === 'label' ? 'classification.labels.name' : 'classification.tags.name')}
        <input value={draft.name} disabled={busy} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
        <label>{t('classification.description')}<textarea rows={2} value={draft.description} disabled={busy}
          onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
        {editing.kind === 'tag' ? <label>{t('classification.color')}<ColorPicker value={draft.color} disabled={busy}
          onChange={(color) => setDraft({ ...draft, color })} /></label> : <>
          <h4>{t('classification.labels.values')}</h4>
          {draft.values.map((value, index) => <div className="classification-value-row" key={value.id || index}>
            <input aria-label={`${t('classification.labels.value')} ${index + 1}`} value={value.value} disabled={busy}
              onChange={(event) => setDraft({ ...draft, values: draft.values.map((item, at) => at === index ? { ...item, value: event.target.value } : item) })} />
            <ColorPicker value={value.color} disabled={busy} onChange={(color) => setDraft({ ...draft,
              values: draft.values.map((item, at) => at === index ? { ...item, color } : item) })} />
            <button className="btn ghost sm" disabled={busy || draft.values.length === 1} onClick={() => setDraft({ ...draft,
              values: draft.values.filter((_, at) => at !== index) })}>{t('common.delete')}</button></div>)}
          <button className="btn ghost sm" disabled={busy} onClick={() => setDraft({ ...draft,
            values: [...draft.values, { value: '', color: NEW_COLOR }] })}>{t('classification.labels.addValue')}</button></>}
        {error && <p className="err-text" role="alert">{error}</p>}
      </div>
    </Modal>}
    {deleting && <TypeToConfirmDialog title={t(deleting.kind === 'label' ? 'classification.labels.delete' : 'classification.tags.delete')}
      description={t('classification.deleteImpact', { count: deleting.item.assignment_count })}
      resourceName={deleting.item.name} resourceId={deleting.item.id} confirmLabel={t('common.delete')}
      loading={busy} onConfirm={confirmDelete} onCancel={() => setDeleting(null)} />}
  </div>;
}
