import { DEFAULT_SPEED, ENTER_DELAY_MS, SPEED_PRESETS, sendConsoleToken, tokenizeConsoleText } from './keyboard.js';

export class ConsoleTypingBusyError extends Error {
  constructor() {
    super('Một thao tác auto-type đang chạy.');
    this.name = 'ConsoleTypingBusyError';
  }
}

export class ConsoleSessionUnavailableError extends Error {
  constructor() {
    super('Kết nối VNC đã ngắt. Auto-type đã dừng.');
    this.name = 'ConsoleSessionUnavailableError';
  }
}

export function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

export function createConsoleAutoTyper({ getSession, isSessionAvailable, sleep = abortableDelay }) {
  let operation = null;

  async function start(text, { appendEnter = false, speed = DEFAULT_SPEED, onProgress = () => {} } = {}) {
    if (operation) throw new ConsoleTypingBusyError();
    const tokens = tokenizeConsoleText(text, appendEnter);
    const preset = SPEED_PRESETS[speed];
    if (!preset) throw new Error('Tốc độ auto-type không hợp lệ.');

    const session = getSession();
    if (!session || !isSessionAvailable(session)) throw new ConsoleSessionUnavailableError();
    const abortController = new AbortController();
    operation = { abortController, session };
    onProgress({ current: 0, total: tokens.length });

    try {
      session.focus?.({ preventScroll: true });
      for (let index = 0; index < tokens.length; index += 1) {
        if (abortController.signal.aborted) throw abortController.signal.reason;
        if (getSession() !== session || !isSessionAvailable(session)) throw new ConsoleSessionUnavailableError();
        const token = tokens[index];
        sendConsoleToken(session, token);
        onProgress({ current: index + 1, total: tokens.length });
        if (index < tokens.length - 1) {
          const delayMs = token.kind === 'enter' ? ENTER_DELAY_MS : preset.delayMs;
          await sleep(delayMs, abortController.signal);
        }
      }
      return { current: tokens.length, total: tokens.length };
    } finally {
      if (operation?.abortController === abortController) operation = null;
    }
  }

  function cancel(reason = new DOMException('Auto-type cancelled', 'AbortError')) {
    operation?.abortController.abort(reason);
  }

  return {
    start,
    cancel,
    get active() { return operation !== null; },
  };
}
