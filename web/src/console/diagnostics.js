// Never emit URL values, event objects, server reason strings, or error messages.
// Path segments outside this small public routing vocabulary may contain secrets.
const PUBLIC_SEGMENTS = new Set(['vnc_auto.html', 'vnc_lite.html', 'vnc.html', 'websockify', 'novnc', 'novnc-proxy', 'vnc']);

export function consoleUrlShape(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return '<invalid URL>';
    const pathname = url.pathname.split('/').map((part) => !part || PUBLIC_SEGMENTS.has(part) ? part : '<redacted>').join('/');
    return `${url.origin}${pathname}${url.search ? '?<redacted>' : ''}${url.hash ? '#<redacted>' : ''}`;
  } catch {
    return '<invalid URL>';
  }
}

export function createConsoleDiagnostics(enabled, write = (entry) => console.info('[console diagnostics]', entry)) {
  if (!enabled) return null;
  let attempt = 0;
  let rfbConnected = false;
  return {
    begin(pageUrl, secureContext) {
      attempt += 1;
      rfbConnected = false;
      write({ event: 'attempt', attempt, page: consoleUrlShape(new URL('/', pageUrl).href), secureContext: !!secureContext });
    },
    nova(url) { write({ event: 'nova_response', attempt, url: consoleUrlShape(url) }); },
    endpoint(url, pageProtocol) {
      write({ event: 'rfb_endpoint', attempt, url: consoleUrlShape(url), mixedContent: pageProtocol === 'https:' && new URL(url).protocol === 'ws:' });
    },
    rfb(event, detail) {
      if (event === 'connect') rfbConnected = true;
      const entry = { event: `rfb_${event}`, attempt, rfbConnected };
      if (event === 'disconnect') entry.clean = detail?.clean === true;
      // Desktop names, credentials, and security-failure reason may be sensitive.
      write(entry);
    },
    failure(stage) { write({ event: 'failure', attempt, stage, rfbConnected }); },
    observeSocket(socket) {
      const socketAttempt = attempt;
      let opened = false;
      const onOpen = () => {
        opened = true;
        write({ event: 'ws_open', attempt: socketAttempt, handshake: 'accepted' });
      };
      const onError = () => write({ event: 'ws_error', attempt: socketAttempt, opened, httpStatus: 'not exposed by WebSocket API' });
      const onClose = (event) => {
        write({ event: 'ws_close', attempt: socketAttempt, opened, code: event.code, clean: event.wasClean === true,
          reason: event.reason ? '<redacted; inspect locally>' : '', rfbConnected: socketAttempt === attempt && rfbConnected });
        detach();
      };
      function detach() {
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('error', onError);
        socket.removeEventListener('close', onClose);
      }
      socket.addEventListener('open', onOpen);
      socket.addEventListener('error', onError);
      socket.addEventListener('close', onClose);
      return detach;
    },
  };
}

// noVNC 1.5 accepts a native WebSocket as its second constructor argument.
// Its ordinary URL-based construction is retained when diagnostics are disabled.
export function createObservedRfb(RFB, target, url, diagnostics, Socket = WebSocket) {
  if (!diagnostics) return new RFB(target, url, { shared: true });
  const socket = new Socket(url);
  const detach = diagnostics.observeSocket(socket);
  try {
    return new RFB(target, socket, { shared: true });
  } catch {
    detach();
    socket.close();
    throw new Error('Không thể khởi tạo kết nối console.');
  }
}
