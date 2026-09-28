import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '../i18n/react.jsx';
import { foregroundForColor } from '../classification.js';

export function ClassificationChip({ text, title, color }) {
  const safeColor = /^#[0-9A-Fa-f]{6}$/.test(color || '') ? color : '#E5E7EB';
  return <span className="classification-chip" title={title || text}
    style={{ backgroundColor: safeColor, color: foregroundForColor(safeColor) }}>{text}</span>;
}

export function ColorPicker({ value, onChange, disabled }) {
  const { t } = useI18n();
  const valid = /^#[0-9A-Fa-f]{6}$/.test(value || '');
  return <div className="classification-color-picker">
    <input type="color" aria-label={t('classification.color')} value={valid ? value : '#64748B'}
      disabled={disabled} onChange={(event) => onChange(event.target.value.toUpperCase())} />
    <input aria-label={t('classification.colorHex')} value={value} placeholder="#RRGGBB" maxLength={7}
      disabled={disabled} onChange={(event) => onChange(event.target.value)} />
  </div>;
}

export default function ClassificationPicker({ catalog, selection, onChange, disabled }) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const labels = catalog?.labels || [];
  const tags = catalog?.tags || [];
  if (!labels.length && !tags.length) return <p className="dim">{t('classification.emptyProject')} <Link to="/labels-tags">{t('classification.manage')}</Link></p>;
  const selected = new Map(selection.labels.map((item) => [item.label_id, item.value_id]));
  const searched = query.trim().toLocaleLowerCase();
  return <div className="classification-picker">
    {(labels.length + tags.length > 8) && <input aria-label={t('classification.search')} placeholder={t('classification.search')}
      value={query} onChange={(event) => setQuery(event.target.value)} />}
    {labels.filter((item) => !searched || item.name.toLocaleLowerCase().includes(searched)
      || item.values.some((value) => value.value.toLocaleLowerCase().includes(searched))).map((label) =>
      <label className="classification-select" key={label.id}><span>{label.name}</span>
        <select value={selected.get(label.id) || ''} disabled={disabled} onChange={(event) => onChange({ ...selection,
          labels: [...selection.labels.filter((item) => item.label_id !== label.id),
            ...(event.target.value ? [{ label_id: label.id, value_id: event.target.value }] : [])] })}>
          <option value="">{t('classification.notSet')}</option>
          {label.values.map((value) => <option key={value.id} value={value.id}>{value.value}</option>)}
        </select></label>)}
    {tags.length > 0 && <><h4>{t('classification.tags')}</h4><div className="classification-tag-options">
      {tags.filter((item) => !searched || item.name.toLocaleLowerCase().includes(searched)).map((tag) =>
        <label key={tag.id} className="check-item"><input type="checkbox" disabled={disabled}
          checked={selection.tag_ids.includes(tag.id)} onChange={(event) => onChange({ ...selection,
            tag_ids: event.target.checked ? [...selection.tag_ids, tag.id] : selection.tag_ids.filter((id) => id !== tag.id) })} />
          <ClassificationChip text={tag.name} color={tag.color} /></label>)}
    </div></>}
  </div>;
}
