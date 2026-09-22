import React, { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from '../api.js';
import { Modal } from './ui.jsx';
import ConsoleInput from './ConsoleInput.jsx';
import { getNovaConsoleUrl, novaConsoleToWebSocket } from '../console/novaConsole.js';
import { createRfbSession } from '../console/rfbSession.js';
import { createConsoleDiagnostics, createObservedRfb } from '../console/diagnostics.js';

const INITIAL_CONNECTION = { status: 'idle', message: '' };

export default function ConsoleModal({ server, onClose }) {
  const screenRef = useRef(null);
  const rfbRef = useRef(null);
  const sessionRef = useRef(null);
  const [connection, setConnection] = useState(INITIAL_CONNECTION);
  const [sessionVersion, setSessionVersion] = useState(0);
  const [originalConsoleUrl, setOriginalConsoleUrl] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const diagnostics = createConsoleDiagnostics(import.meta.env.DEV && import.meta.env.VITE_CONSOLE_DIAGNOSTICS === 'true');

    Promise.all([
      import('@novnc/novnc/lib/rfb.js'),
      import('@novnc/novnc/lib/util/logging.js'),
    ])
      .then(([rfbModule, loggingModule]) => {
        if (cancelled) return;
        const initLogging = loggingModule.initLogging || loggingModule.default?.initLogging;
        initLogging?.('none');
        const RFB = rfbModule.default?.default || rfbModule.default;
        if (typeof RFB !== 'function') throw new Error('Không thể khởi tạo noVNC RFB client.');

        const session = createRfbSession({
          target: screenRef.current,
          requestConsole: () => api(`/servers/${server.id}/console`, { method: 'POST' }),
          onAttempt: () => {
            setOriginalConsoleUrl(null);
            diagnostics?.begin(window.location.href, window.isSecureContext);
          },
          onResponse: (response) => {
            const original = getNovaConsoleUrl(response);
            diagnostics?.nova(original);
            // The fallback navigates to the untouched HTML URL, never to an inferred WS URL.
            const parsed = new URL(original);
            if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password) setOriginalConsoleUrl(original);
          },
          parseConsoleUrl: (response) => {
            const endpoint = novaConsoleToWebSocket(getNovaConsoleUrl(response));
            diagnostics?.endpoint(endpoint, window.location.protocol);
            // Keep the existing mixed-content guard; diagnostics above record its cause.
            return novaConsoleToWebSocket(getNovaConsoleUrl(response), window.location.protocol);
          },
          createRfb: (target, websocketUrl) => {
            const rfb = createObservedRfb(RFB, target, websocketUrl, diagnostics);
            rfb.scaleViewport = true;
            rfb.resizeSession = false;
            rfb.focusOnClick = true;
            return rfb;
          },
          onState: (state) => {
            if (state.status === 'connected') setOriginalConsoleUrl(null);
            setConnection(state);
          },
          onEvent: (event, detail) => diagnostics?.rfb(event, detail),
          onFailure: (stage) => diagnostics?.failure(stage),
          onRfb: (rfb) => { rfbRef.current = rfb; },
        });
        sessionRef.current = session;
        return session.connect();
      })
      .catch(() => {
        diagnostics?.failure('load_client');
        if (!cancelled) setConnection({ status: 'error', message: 'Không thể mở console VNC.' });
      });

    return () => {
      cancelled = true;
      sessionRef.current?.dispose();
      sessionRef.current = null;
      rfbRef.current = null;
    };
  }, [server.id]);

  const reconnect = () => {
    setSessionVersion((value) => value + 1);
    sessionRef.current?.reconnect();
  };
  const connected = connection.status === 'connected';
  const waiting = ['idle', 'requesting_console', 'connecting'].includes(connection.status);

  return (
    <Modal wide className="console-modal" title={`Console — ${server.name}`} onClose={onClose}
      footer={<button className="btn ghost" type="button" onClick={onClose}>Đóng</button>}>
      <div className="vnc-console-shell">
        <div className="vnc-screen" ref={screenRef} tabIndex={0} onMouseDown={() => rfbRef.current?.focus()} />
        {!connected && <div className="vnc-connection-state" role="status">
          <span>{connection.message || 'Đang chuẩn bị console…'}</span>
          {!waiting && <button className="btn ghost sm" type="button" onClick={reconnect}>
            <RefreshCw size={14} /> Kết nối lại
          </button>}
          {!waiting && originalConsoleUrl && <a className="btn ghost sm" href={originalConsoleUrl} target="_blank" rel="noopener noreferrer">
            Mở console Nova gốc
          </a>}
        </div>}
      </div>
      <ConsoleInput rfbRef={rfbRef} connected={connected} sessionKey={`${server.id}:${sessionVersion}`} />
    </Modal>
  );
}
