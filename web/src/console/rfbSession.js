export function createRfbSession({ requestConsole, parseConsoleUrl, createRfb, target, onState, onRfb }) {
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
    emit('requesting_console', 'Đang lấy phiên console mới từ OpenStack…');

    try {
      const response = await requestConsole();
      if (disposed || attempt !== generation) return;
      const websocketUrl = parseConsoleUrl(response);
      emit('connecting', 'Đang kết nối VNC…');
      const rfb = createRfb(target, websocketUrl);
      if (disposed || attempt !== generation) {
        rfb.disconnect();
        return;
      }
      current = rfb;
      onRfb(rfb);

      listen(rfb, 'connect', () => {
        if (current === rfb) emit('connected', 'Console đã kết nối.');
      });
      listen(rfb, 'disconnect', (event) => {
        if (current !== rfb) return;
        detach(rfb);
        current = null;
        onRfb(null);
        emit('disconnected', event.detail?.clean ? 'Phiên VNC đã đóng.' : 'Kết nối VNC bị gián đoạn.');
      });
      listen(rfb, 'securityfailure', () => {
        if (current === rfb) {
          clearCurrent();
          emit('error', 'Xác thực phiên VNC thất bại.');
        }
      });
      listen(rfb, 'credentialsrequired', () => {
        if (current === rfb) {
          clearCurrent();
          emit('error', 'Phiên VNC yêu cầu thông tin xác thực bổ sung.');
        }
      });
    } catch (error) {
      if (!disposed && attempt === generation) emit('error', error?.message || 'Không thể mở console VNC.');
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
