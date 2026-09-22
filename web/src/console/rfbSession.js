export function createRfbSession({ requestConsole, parseConsoleUrl, createRfb, target, onState, onRfb,
  onResponse = () => {}, onAttempt = () => {}, onEvent = () => {}, onFailure = () => {} }) {
  let generation = 0;
  let current = null;
  let listeners = [];
  let disposed = false;

  function emit(status, message) {
    if (!disposed) onState({ status, message });
  }

  function clearCurrent() {
    const previous = current;
    current = null;
    onRfb(null);
    for (const [rfb, name, listener] of listeners) rfb.removeEventListener(name, listener);
    listeners = [];
    try { previous?.disconnect(); } catch { /* already disconnected */ }
  }

  function listen(rfb, name, listener) {
    rfb.addEventListener(name, listener);
    listeners.push([rfb, name, listener]);
  }

  function detach(rfb) {
    const retained = [];
    for (const entry of listeners) {
      if (entry[0] === rfb) entry[0].removeEventListener(entry[1], entry[2]);
      else retained.push(entry);
    }
    listeners = retained;
  }

  async function connect() {
    if (disposed) return;
    const attempt = ++generation;
    clearCurrent();
    target.replaceChildren();
    onAttempt();
    emit('requesting_console', 'Đang lấy phiên console mới từ OpenStack…');

    let stage = 'request_console';
    try {
      const response = await requestConsole();
      if (disposed || attempt !== generation) return;
      stage = 'parse_url';
      onResponse(response);
      const websocketUrl = parseConsoleUrl(response);
      emit('connecting', 'Đang kết nối VNC…');
      stage = 'construct_rfb';
      const rfb = createRfb(target, websocketUrl);
      if (disposed || attempt !== generation) {
        rfb.disconnect();
        return;
      }
      current = rfb;
      onRfb(rfb);

      listen(rfb, 'connect', () => {
        if (current === rfb) {
          onEvent('connect');
          emit('connected', 'Console đã kết nối.');
        }
      });
      listen(rfb, 'disconnect', (event) => {
        if (current !== rfb) return;
        onEvent('disconnect', { clean: event.detail?.clean === true });
        detach(rfb);
        current = null;
        onRfb(null);
        emit('disconnected', event.detail?.clean ? 'Phiên VNC đã đóng.' : 'Kết nối VNC bị gián đoạn.');
      });
      listen(rfb, 'securityfailure', () => {
        if (current === rfb) {
          onEvent('securityfailure');
          clearCurrent();
          emit('error', 'Xác thực phiên VNC thất bại.');
        }
      });
      listen(rfb, 'credentialsrequired', () => {
        if (current === rfb) {
          onEvent('credentialsrequired');
          clearCurrent();
          emit('error', 'Phiên VNC yêu cầu thông tin xác thực bổ sung.');
        }
      });
      listen(rfb, 'desktopname', () => {
        if (current === rfb) onEvent('desktopname');
      });
    } catch {
      if (!disposed && attempt === generation) {
        clearCurrent();
        onFailure(stage);
        emit('error', 'Không thể mở console VNC.');
      }
    }
  }

  function dispose() {
    if (disposed) return;
    generation += 1;
    clearCurrent();
    target.replaceChildren();
    disposed = true;
  }

  return {
    connect,
    reconnect: connect,
    dispose,
    get current() { return current; },
  };
}
