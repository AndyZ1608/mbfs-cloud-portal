import React, { useId, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { nameSuggestions } from '../resourceNameFilter.js';

export default function ResourceNameFilter({ value, onChange, resources, label, placeholder, clearLabel, emptyText }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const root = useRef(null);
  const id = useId();
  const options = nameSuggestions(resources, value);
  const expanded = open && !!value.trim();

  function choose(name) {
    onChange(name);
    setOpen(false);
    setActive(-1);
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') { setOpen(false); setActive(-1); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!options.length) return;
      event.preventDefault();
      setOpen(true);
      setActive((current) => event.key === 'ArrowDown'
        ? (current + 1) % options.length : (current <= 0 ? options.length - 1 : current - 1));
    } else if (event.key === 'Enter' && expanded && active >= 0 && options[active]) {
      event.preventDefault();
      choose(options[active]);
    }
  }

  return <div className="resource-name-filter" ref={root}
    onBlur={(event) => { if (!root.current?.contains(event.relatedTarget)) setOpen(false); }}>
    <label htmlFor={`${id}-input`} className="field-label">{label}</label>
    <div className="resource-name-input">
      <input id={`${id}-input`} type="text" role="combobox" aria-autocomplete="list"
        aria-expanded={expanded} aria-controls={expanded ? `${id}-options` : undefined}
        aria-activedescendant={expanded && active >= 0 && active < options.length ? `${id}-option-${active}` : undefined}
        autoComplete="off" value={value} placeholder={placeholder}
        onChange={(event) => { onChange(event.target.value); setActive(-1); setOpen(true); }}
        onFocus={() => { if (value.trim()) setOpen(true); }} onKeyDown={onKeyDown} />
      {value && <button type="button" className="resource-name-clear" aria-label={clearLabel}
        onClick={() => { onChange(''); setOpen(false); setActive(-1); }}><X size={14} /></button>}
    </div>
    {expanded && <div id={`${id}-options`} className="resource-name-options" role="listbox" aria-label={label}>
      {options.length ? options.map((name, index) => <div key={name} id={`${id}-option-${index}`}
        role="option" aria-selected={index === active} className={index === active ? 'active' : ''}
        title={name} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(name)}>{name}</div>)
        : <div className="resource-name-empty">{emptyText}</div>}
    </div>}
  </div>;
}
