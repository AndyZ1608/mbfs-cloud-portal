import { CHARACTER_DELAY_MS, ENTER_DELAY_MS, sendConsoleToken, tokenizeConsoleText } from './keyboard.js';

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
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function createConsoleAutoTyper({ getSession, isSessionAvailable, sleep = abortableDelay }) {
  let operation = null;

  async function start(text, { appendEnter = false, onProgress = () => {} } = {}) {
    if (operation) throw new ConsoleTypingBusyError();
    const tokens = tokenizeConsoleText(text, appendEnter);

    const session = getSession();
    if (!session || !isSessionAvailable(session)) throw new ConsoleSessionUnavailableError();
    const abortController = new AbortController();
    operation = { abortController, session };
    onProgress({ current: 0, total: tokens.length });

    try {
      for (let index = 0; index < tokens.length; index += 1) {
        if (abortController.signal.aborted) throw abortController.signal.reason;
        if (getSession() !== session || !isSessionAvailable(session)) throw new ConsoleSessionUnavailableError();
        const token = tokens[index];
        sendConsoleToken(session, token);
        onProgress({ current: index + 1, total: tokens.length });
        if (index < tokens.length - 1) {
          const delayMs = token.kind === 'enter' ? ENTER_DELAY_MS : CHARACTER_DELAY_MS;
          await sleep(delayMs, abortController.signal);
        }
      }
      if (abortController.signal.aborted) throw abortController.signal.reason;
      if (getSession() !== session || !isSessionAvailable(session)) throw new ConsoleSessionUnavailableError();
      session.focus?.({ preventScroll: true });
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
