import React, { useState } from 'react';
import { Eraser, Keyboard, Play, Square } from 'lucide-react';
import useConsoleAutoType from '../console/useConsoleAutoType.js';
import { useI18n } from '../i18n/react.jsx';

export default function ConsoleInput({ rfbRef, connected, sessionKey, unavailableReason = '' }) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const { state, start, cancel, typing } = useConsoleAutoType({ rfbRef, connected, sessionKey });
  const canType = !unavailableReason && connected && !typing && text.length > 0;

  return (
    <section className="console-input-panel" aria-labelledby="console-input-title">
      <div className="console-input-head">
        <div><h4 id="console-input-title"><Keyboard size={16} /> {t('console.input')}</h4>
          <span className="dim">{t('console.memoryOnly')}</span></div>
      </div>

      <textarea
        className="console-input-textarea mono"
        rows={3}
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={t('console.placeholder')}
        disabled={typing}
        spellCheck="false"
        aria-label={t('console.input')}
      />

      <div className="console-input-actions">
        <button className="btn ghost" type="button" onClick={() => setText('')} disabled={typing || text.length === 0}>
          <Eraser size={15} /> {t('console.clear')}
        </button>
        <span className="console-input-spacer" />
        {typing && <span className="console-typing-status" role="status">{t('console.typing')} <b>{state.current} / {state.total}</b></span>}
        {typing && <button className="btn danger-ghost sm" type="button" onClick={cancel}><Square size={13} /> {t('console.cancelTyping')}</button>}
        <button className="btn primary" type="button" onClick={() => start(text)} disabled={!canType}>
          <Play size={15} /> {t('console.typeAndEnter')}
        </button>
      </div>

      {!typing && state.message && <p className={`console-input-message ${state.phase === 'error' ? 'err-text' : 'dim'}`} role="status">{state.phase === 'complete' ? t('console.typed') : state.phase === 'cancelled' ? t('console.cancelled') : t('console.typeFailed')}</p>}
      {unavailableReason
        ? <p className="console-input-message warn-text" role="status">{unavailableReason}</p>
        : !connected && <p className="console-input-message warn-text" role="status">{t('console.autoTypeUnavailable')}</p>}
    </section>
  );
}
