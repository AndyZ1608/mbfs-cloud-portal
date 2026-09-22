import React, { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from '../api.js';
import { Modal } from './ui.jsx';
import ConsoleInput from './ConsoleInput.jsx';
import { consoleUrlToWebSocket } from '../console/url.js';

export default function ConsoleModal({ server, onClose }) {
  const screenRef = useRef(null);
  const rfbRef = useRef(null);
  const [connection, setConnection] = useState({ status: 'connecting', message: 'Đang kết nối VNC…' });
  const [sessionVersion, setSessionVersion] = useState(0);

  useEffect(() => {
    let disposed = false;
    let rfb = null;
    setConnection({ status: 'connecting', message: 'Đang lấy phiên console…' });
    screenRef.current?.replaceChildren();

    Promise.all([
      api(`/servers/${server.id}/console`, { method: 'POST' }),
      import('@novnc/novnc/lib/rfb.js'),
    ])
      .then(([data, rfbModule]) => {
        if (disposed) return;
        const RFB = rfbModule.default?.default || rfbModule.default;
        if (typeof RFB !== 'function') throw new Error('Không thể khởi tạo noVNC RFB client.');
        const consoleUrl = data.remote_console?.url || data.console?.url;
        if (!consoleUrl) throw new Error('OpenStack không trả về URL console.');
        const websocketUrl = consoleUrlToWebSocket(consoleUrl);
        rfb = new RFB(screenRef.current, websocketUrl, { shared: true });
        rfbRef.current = rfb;
        rfb.scaleViewport = true;
        rfb.resizeSession = false;
        rfb.focusOnClick = true;

        rfb.addEventListener('connect', () => {
          if (!disposed && rfbRef.current === rfb) setConnection({ status: 'connected', message: 'Đã kết nối' });
        });
        rfb.addEventListener('disconnect', (event) => {
          if (disposed || rfbRef.current !== rfb) return;
          rfbRef.current = null;
          setConnection({
            status: event.detail?.clean ? 'disconnected' : 'error',
            message: event.detail?.clean ? 'Phiên VNC đã đóng.' : 'Kết nối VNC bị gián đoạn.',
          });
        });
        rfb.addEventListener('securityfailure', () => {
          if (!disposed) setConnection({ status: 'error', message: 'Xác thực phiên VNC thất bại.' });
        });
        rfb.addEventListener('credentialsrequired', () => {
          if (!disposed) setConnection({ status: 'error', message: 'Phiên VNC yêu cầu thông tin xác thực bổ sung.' });
        });
        setConnection({ status: 'connecting', message: 'Đang bắt tay với VNC…' });
      })
      .catch((error) => {
        if (!disposed) setConnection({ status: 'error', message: error?.message || 'Không thể mở console VNC.' });
      });

    return () => {
      disposed = true;
      if (rfbRef.current === rfb) rfbRef.current = null;
      try { rfb?.disconnect(); } catch { /* phiên đã đóng */ }
      screenRef.current?.replaceChildren();
    };
  }, [server.id, sessionVersion]);

  const connected = connection.status === 'connected';
  return (
    <Modal wide className="console-modal" title={`Console — ${server.name}`} onClose={onClose}
      footer={<button className="btn ghost" type="button" onClick={onClose}>Đóng</button>}>
      <div className="vnc-console-shell">
        <div className="vnc-screen" ref={screenRef} onMouseDown={() => rfbRef.current?.focus()} />
        {!connected && <div className="vnc-connection-state" role="status">
          <span>{connection.message}</span>
          {connection.status !== 'connecting' && <button className="btn ghost sm" type="button" onClick={() => setSessionVersion((value) => value + 1)}>
            <RefreshCw size={14} /> Kết nối lại
          </button>}
        </div>}
      </div>
      <ConsoleInput rfbRef={rfbRef} connected={connected} sessionKey={`${server.id}:${sessionVersion}`} />
    </Modal>
  );
}
