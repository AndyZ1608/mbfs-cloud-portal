import React, { useState } from 'react';
import { useI18n } from '../i18n/react.jsx';

const SUGGESTED_KEYS = ['environment', 'application', 'owner', 'team', 'department', 'cost_center', 'backup', 'criticality', 'managed_by'];
const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export function rowsFromLabels(labels) {
  return Object.entries(labels || {}).map(([key, value]) => ({ key, value }));
}

export function editorPayload(rows, tags, t) {
  const labels = Object.create(null);
  for (const row of rows) {
    const key = row.key.trim().toLowerCase();
    if (!key || key.startsWith('cmp.') || !KEY_PATTERN.test(key) || !row.value.trim()) {
      throw new Error(t('instance.labelsTags.invalidLabel'));
    }
    if (Object.hasOwn(labels, key)) throw new Error(t('instance.labelsTags.duplicateLabel'));
    labels[key] = row.value;
  }
  return { labels, tags };
}

export default function LabelsTagsEditor({ rows, onRowsChange, tags, onTagsChange, disabled }) {
  const { t } = useI18n();
  const [draftTag, setDraftTag] = useState('');
  const [tagError, setTagError] = useState('');
  function addTag() {
    const tag = draftTag.trim();
    if (!tag || tag.includes('/') || tag.includes(',') || [...tag].length > 60) {
      setTagError(t('instance.labelsTags.invalidTag'));
      return;
    }
    if (tags.includes(tag)) { setTagError(t('instance.labelsTags.duplicateTag')); return; }
    onTagsChange([...tags, tag]);
    setDraftTag('');
    setTagError('');
  }
  return <div className="labels-tags-editor">
    <datalist id="instance-label-key-suggestions">{SUGGESTED_KEYS.map((key) => <option key={key} value={key} />)}</datalist>
    <h4>{t('instance.labels.title')}</h4>
    {rows.map((row, index) => <div className="label-edit-row" key={index}>
      <input aria-label={`${t('instance.labels.key')} ${index + 1}`} list="instance-label-key-suggestions"
        placeholder={t('instance.labels.key')} value={row.key} disabled={disabled}
        onChange={(event) => onRowsChange(rows.map((item, at) => at === index ? { ...item, key: event.target.value } : item))} />
      <input aria-label={`${t('instance.labels.value')} ${index + 1}`} placeholder={t('instance.labels.value')}
        value={row.value} disabled={disabled}
        onChange={(event) => onRowsChange(rows.map((item, at) => at === index ? { ...item, value: event.target.value } : item))} />
      <button className="btn ghost sm" type="button" disabled={disabled} aria-label={`${t('instance.labels.remove')} ${index + 1}`}
        onClick={() => onRowsChange(rows.filter((_, at) => at !== index))}>{t('instance.labels.remove')}</button>
    </div>)}
    <button className="btn ghost sm" type="button" disabled={disabled} onClick={() => onRowsChange([...rows, { key: '', value: '' }])}>
      {t('instance.labels.add')}
    </button>
    <h4>{t('instance.tags.title')}</h4>
    {tags.length ? <div className="tag-edit-chips">{tags.map((tag) => <span className="chip" key={tag}>{tag}
      <button type="button" disabled={disabled} aria-label={`${t('instance.tags.remove')} ${tag}`}
        onClick={() => onTagsChange(tags.filter((item) => item !== tag))}>×</button></span>)}</div>
      : <p className="dim">{t('instance.tags.empty')}</p>}
    <div className="tag-entry"><input aria-label={t('instance.tags.add')} value={draftTag} disabled={disabled}
      placeholder={t('instance.tags.placeholder')} onChange={(event) => { setDraftTag(event.target.value); setTagError(''); }}
      onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addTag(); } }} />
      <button className="btn ghost sm" type="button" disabled={disabled || !draftTag.trim()} onClick={addTag}>{t('instance.tags.add')}</button></div>
    {tagError && <p className="err-text" role="alert">{tagError}</p>}
  </div>;
}
