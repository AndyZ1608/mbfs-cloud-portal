import React, { useState } from 'react';
import { Eraser, Keyboard, Play, Square } from 'lucide-react';
import { DEFAULT_SPEED, SPEED_PRESETS } from '../console/keyboard.js';
import useConsoleAutoType from '../console/useConsoleAutoType.js';

export default function ConsoleInput({ rfbRef, connected, sessionKey, unavailableReason = '' }) {
  const [text, setText] = useState('');
  const [speed, setSpeed] = useState(DEFAULT_SPEED);
  const { state, start, cancel, typing } = useConsoleAutoType({ rfbRef, connected, sessionKey });
  const canType = !unavailableReason && connected && !typing && text.length > 0;

  return (
    <section className="console-input-panel" aria-labelledby="console-input-title">
      <div className="console-input-head">
        <div><h4 id="console-input-title"><Keyboard size={16} /> Console Input</h4>
          <span className="dim">Nội dung chỉ được giữ trong bộ nhớ của trang này.</span></div>
        <label className="console-speed"><span>Tốc độ</span>
          <select value={speed} onChange={(event) => setSpeed(event.target.value)} disabled={typing}>
            {Object.entries(SPEED_PRESETS).map(([value, preset]) => (
              <option key={value} value={value}>{preset.label} · {preset.delayMs} ms</option>
            ))}
          </select>
        </label>
      </div>

      <textarea
        className="console-input-textarea mono"
        rows={5}
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="Dán lệnh hoặc nội dung cần nhập vào console…"
        disabled={typing}
        spellCheck="false"
        aria-label="Console Input"
      />

      <div className="console-input-actions">
        <button className="btn ghost" type="button" onClick={() => setText('')} disabled={typing || text.length === 0}>
          <Eraser size={15} /> Xoá nội dung
        </button>
        <span className="console-input-spacer" />
        <button className="btn ghost" type="button" onClick={() => start(text, false, speed)} disabled={!canType}>
          <Keyboard size={15} /> Type
        </button>
        <button className="btn primary" type="button" onClick={() => start(text, true, speed)} disabled={!canType}>
          <Play size={15} /> Type + Enter
        </button>
      </div>

      {typing && <div className="console-typing-status" role="status">
        <span>Đang nhập… <b>{state.current} / {state.total}</b></span>
        <button className="btn danger-ghost sm" type="button" onClick={cancel}><Square size={13} /> Huỷ auto-type</button>
      </div>}
      {!typing && state.message && <p className={`console-input-message ${state.phase === 'error' ? 'err-text' : 'dim'}`} role="status">{state.message}</p>}
      {unavailableReason
        ? <p className="console-input-message warn-text" role="status">{unavailableReason}</p>
        : !connected && <p className="console-input-message warn-text" role="status">Auto-type khả dụng sau khi VNC kết nối thành công.</p>}
      <p className="console-input-note dim">Type chỉ nhập nội dung. Type + Enter gửi thêm Enter nếu nội dung chưa kết thúc bằng dòng mới. Bố cục bàn phím mục tiêu: US.</p>
    </section>
  );
}
