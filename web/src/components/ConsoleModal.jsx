import React, { useEffect, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { api } from '../api.js';
import { Modal } from './ui.jsx';
import ConsoleInput from './ConsoleInput.jsx';
import { getNovaConsoleUrl } from '../console/novaConsole.js';

const NO_RFB_REF = { current: null };
const AUTO_TYPE_UNAVAILABLE = 'Auto-Type yêu cầu phiên noVNC do CMP sở hữu hoặc tích hợp cùng origin.';

export default function ConsoleModal({ server, onClose }) {
  const [requestVersion, setRequestVersion] = useState(0);
  const [consoleSession, setConsoleSession] = useState({ status: 'loading', url: '', message: '' });

  useEffect(() => {
    let disposed = false;
    setConsoleSession({ status: 'loading', url: '', message: '' });

    api(`/servers/${server.id}/console`, { method: 'POST' })
      .then((data) => {
        if (!disposed) setConsoleSession({ status: 'ready', url: getNovaConsoleUrl(data), message: '' });
      })
      .catch((error) => {
        if (!disposed) {
          setConsoleSession({ status: 'error', url: '', message: error?.message || 'Không thể lấy phiên console VNC.' });
        }
      });

    return () => { disposed = true; };
  }, [server.id, requestVersion]);

  return (
    <Modal wide className="console-modal" title={`Console — ${server.name}`} onClose={onClose}
      footer={<button className="btn ghost" type="button" onClick={onClose}>Đóng</button>}>
      <section className="console-launch-panel" aria-live="polite">
        <div>
          <h4>Nova noVNC Console</h4>
          {consoleSession.status === 'loading' && <p className="dim">Đang lấy phiên console mới từ OpenStack…</p>}
          {consoleSession.status === 'ready' && <p className="dim">Console sẽ mở bằng trình khách noVNC do OpenStack cung cấp.</p>}
          {consoleSession.status === 'error' && <p className="err-text">{consoleSession.message}</p>}
        </div>
        <div className="console-launch-actions">
          {consoleSession.status === 'error' && <button className="btn ghost" type="button" onClick={() => setRequestVersion((value) => value + 1)}>
            <RefreshCw size={15} /> Lấy phiên mới
          </button>}
          {consoleSession.status === 'ready' && <a className="btn primary" href={consoleSession.url} target="_blank" rel="noopener noreferrer">
            <ExternalLink size={15} /> Mở console (noVNC)
          </a>}
        </div>
      </section>

      <ConsoleInput
        rfbRef={NO_RFB_REF}
        connected={false}
        sessionKey={server.id}
        unavailableReason={AUTO_TYPE_UNAVAILABLE}
      />
    </Modal>
  );
}
