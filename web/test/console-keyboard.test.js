import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import {
  CHARACTER_DELAY_MS, ENTER_DELAY_MS, UnsupportedConsoleCharacterError,
  mapConsoleCharacter, sendConsoleToken, tokenizeConsoleText,
} from '../src/console/keyboard.js';
import {
  ConsoleSessionUnavailableError, ConsoleTypingBusyError, abortableDelay, createConsoleAutoTyper,
} from '../src/console/autoType.js';
import { getNovaConsoleUrl, novaConsoleToWebSocket } from '../src/console/novaConsole.js';
import { createRfbSession } from '../src/console/rfbSession.js';

function mockRfb() {
  return {
    calls: [],
    focused: 0,
    focus() { this.focused += 1; },
    sendKey(...args) { this.calls.push(args); },
  };
}

function immediateTyper(rfb, available = () => true) {
  return createConsoleAutoTyper({
    getSession: () => rfb,
    isSessionAvailable: available,
    sleep: async () => {},
  });
}

test('maps basic text, uppercase, and common shell symbols to US keyboard keys', () => {
  assert.deepEqual(mapConsoleCharacter('a'), { kind: 'character', keysym: 97, code: 'KeyA', shift: false });
  assert.deepEqual(mapConsoleCharacter('A'), { kind: 'character', keysym: 65, code: 'KeyA', shift: true });
  assert.deepEqual(mapConsoleCharacter('_'), { kind: 'character', keysym: 95, code: 'Minus', shift: true });
  assert.deepEqual(mapConsoleCharacter('|'), { kind: 'character', keysym: 124, code: 'Backslash', shift: true });
  assert.doesNotThrow(() => tokenizeConsoleText('sudo apt update && echo "hello" | grep hello'));
  assert.doesNotThrow(() => tokenizeConsoleText('_ | : ? + { } < >'));
});

test('normalizes multiline CRLF and maps newline and tab to VNC keys', () => {
  const tokens = tokenizeConsoleText('cd /opt\r\n\tls -la');
  assert.equal(tokens.filter((token) => token.kind === 'enter').length, 1);
  assert.equal(tokens.filter((token) => token.kind === 'tab').length, 1);
  assert.equal(tokens.find((token) => token.kind === 'enter').keysym, 0xff0d);
  assert.equal(tokens.find((token) => token.kind === 'tab').keysym, 0xff09);
});

test('Type + Enter adds exactly one final Enter, including trailing newline input', () => {
  assert.equal(tokenizeConsoleText('ip -br a', false).at(-1).kind, 'character');
  assert.equal(tokenizeConsoleText('ip -br a', true).filter((token) => token.kind === 'enter').length, 1);
  assert.equal(tokenizeConsoleText('ip -br a\n', true).filter((token) => token.kind === 'enter').length, 1);
});

test('typing uses fixed 50 ms character / 100 ms Enter delays and focuses only after success', async () => {
  const rfb = mockRfb();
  const delays = [];
  const typer = createConsoleAutoTyper({
    getSession: () => rfb,
    isSessionAvailable: () => true,
    sleep: async (delay) => { assert.equal(rfb.focused, 0); delays.push(delay); },
  });
  await typer.start('A\na');
  assert.deepEqual(rfb.calls.slice(0, 3), [[0xffe1, 'ShiftLeft', true], [65, 'KeyA'], [0xffe1, 'ShiftLeft', false]]);
  assert.deepEqual(rfb.calls.at(-1), [97, 'KeyA']);
  assert.equal(CHARACTER_DELAY_MS, 50);
  assert.equal(ENTER_DELAY_MS, 100);
  assert.deepEqual(delays, [50, 100]);
  assert.equal(rfb.focused, 1);
});

test('unsupported Unicode fails before any key is sent without exposing command context', async () => {
  const rfb = mockRfb();
  await assert.rejects(
    immediateTyper(rfb).start('abc🙂def'),
    (error) => error instanceof UnsupportedConsoleCharacterError && error.position === 3 && !error.message.includes('abc'),
  );
  assert.equal(rfb.calls.length, 0);
});

test('simulated Shift is released even when sending its character fails', () => {
  const calls = [];
  assert.throws(() => sendConsoleToken({ sendKey(...args) {
    calls.push(args);
    if (args[1] === 'KeyA') throw new Error('disconnected');
  } }, mapConsoleCharacter('A')), /disconnected/);
  assert.deepEqual(calls.at(-1), [0xffe1, 'ShiftLeft', false]);
});

test('typing delays release abort listeners on completion and cancellation', async () => {
  const controller = new AbortController();
  await abortableDelay(1, controller.signal);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  const pending = abortableDelay(1000, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('cancellation stops all remaining characters', async () => {
  const rfb = mockRfb();
  const typer = immediateTyper(rfb);
  await assert.rejects(
    typer.start('abcdef', {
      onProgress: ({ current }) => { if (current === 3) typer.cancel(); },
    }),
    (error) => error?.name === 'AbortError',
  );
  assert.equal(rfb.calls.length, 3);
  assert.equal(rfb.focused, 0);
});

test('Type + Enter sends multiline commands with no duplicate final Enter', async () => {
  for (const ending of ['', '\n', '\r\n']) {
    const rfb = mockRfb();
    await immediateTyper(rfb).start(`ip -br a\r\nip route\r\ndf -h${ending}`, { appendEnter: true });
    const actual = rfb.calls.map(([keysym]) => keysym === 0xff0d ? '\n' : String.fromCodePoint(keysym)).join('');
    assert.equal(actual, 'ip -br a\nip route\ndf -h\n');
  }
});

test('a second operation cannot start while typing', async () => {
  const rfb = mockRfb();
  const typer = createConsoleAutoTyper({
    getSession: () => rfb,
    isSessionAvailable: () => true,
    sleep: (_delay, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
  });
  const first = typer.start('ab');
  await assert.rejects(typer.start('second'), (error) => error instanceof ConsoleTypingBusyError);
  typer.cancel();
  await assert.rejects(first, (error) => error?.name === 'AbortError');
});

test('typing stops when the active RFB session becomes unavailable', async () => {
  const rfb = mockRfb();
  let available = true;
  const typer = immediateTyper(rfb, () => available);
  await assert.rejects(
    typer.start('abcdef', { onProgress: ({ current }) => { if (current === 2) available = false; } }),
    (error) => error instanceof ConsoleSessionUnavailableError,
  );
  assert.equal(rfb.calls.length, 2);
});

test('parses Nova noVNC client URLs without losing encoded path or query data', () => {
  const url = 'https://novnc.example:6080/vnc_auto.html?path=websockify%3Ftoken%3Dredacted&extra=keep-me';
  assert.equal(getNovaConsoleUrl({ remote_console: { url } }), url);
  assert.equal(novaConsoleToWebSocket(url), 'wss://novnc.example:6080/websockify?token=redacted&extra=keep-me');
  assert.equal(
    novaConsoleToWebSocket('http://novnc.example/vnc_lite.html?path=%3Ftoken%3Dredacted'),
    'ws://novnc.example/?token=redacted',
  );
  assert.throws(() => getNovaConsoleUrl({ remote_console: {} }), /không trả về URL console/);
  assert.throws(() => novaConsoleToWebSocket('not-a-url'), /không hợp lệ/);
  assert.throws(() => novaConsoleToWebSocket('https://novnc.example/other.html?token=x'), /không được hỗ trợ/);
  assert.throws(
    () => novaConsoleToWebSocket('https://novnc.example/vnc_auto.html?path=https%3A%2F%2Fevil.example%2Fws'),
    /không hợp lệ/,
  );
  assert.throws(
    () => novaConsoleToWebSocket('http://novnc.example/vnc_auto.html?token=x', 'https:'),
    /phải dùng TLS/,
  );
  assert.throws(
    () => novaConsoleToWebSocket('https://user:secret@novnc.example/vnc_auto.html?token=sensitive-token'),
    (error) => !error.message.includes('secret') && !error.message.includes('sensitive-token'),
  );
});

function lifecycleRfb() {
  const listeners = new Map();
  return {
    disconnects: 0,
    addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener(name, listener) { if (listeners.get(name) === listener) listeners.delete(name); },
    disconnect() { this.disconnects += 1; },
    emit(name, detail = {}) { listeners.get(name)?.({ detail }); },
    get listenerCount() { return listeners.size; },
  };
}

test('RFB lifecycle owns one session, reconnects with a fresh URL, and cleans up', async () => {
  const target = { clears: 0, replaceChildren() { this.clears += 1; } };
  const created = [];
  const urls = [];
  const states = [];
  let requests = 0;
  let active = null;
  const session = createRfbSession({
    target,
    requestConsole: async () => ({ sequence: ++requests }),
    parseConsoleUrl: ({ sequence }) => `wss://novnc.example/websockify?token=redacted-${sequence}`,
    createRfb: (_target, url) => {
      urls.push(url);
      const rfb = lifecycleRfb();
      created.push(rfb);
      return rfb;
    },
    onState: (state) => states.push(state.status),
    onRfb: (rfb) => { active = rfb; },
  });

  await session.connect();
  assert.equal(requests, 1);
  assert.equal(created.length, 1);
  assert.equal(active, created[0]);
  created[0].emit('connect');
  assert.equal(states.at(-1), 'connected');

  // Console Input text and progress are component-local and never call this controller.
  assert.equal(session.current, created[0]);
  assert.equal(created.length, 1);

  await session.reconnect();
  assert.equal(requests, 2);
  assert.equal(created.length, 2);
  assert.equal(created[0].disconnects, 1);
  assert.equal(created[0].listenerCount, 0);
  assert.equal(active, created[1]);
  assert.notEqual(urls[0], urls[1]);

  session.dispose();
  assert.equal(created[1].disconnects, 1);
  assert.equal(created[1].listenerCount, 0);
  assert.equal(active, null);
  assert.equal(session.current, null);
});

test('disposing a pending console request prevents a late RFB session from being created', async () => {
  let resolve;
  let creations = 0;
  let active = null;
  const session = createRfbSession({
    target: { replaceChildren() {} },
    requestConsole: () => new Promise((done) => { resolve = done; }),
    parseConsoleUrl: () => 'wss://novnc.example/websockify?token=redacted',
    createRfb: () => { creations += 1; return lifecycleRfb(); },
    onState() {},
    onRfb: (rfb) => { active = rfb; },
  });
  const pending = session.connect();
  session.dispose();
  resolve({});
  await pending;
  assert.equal(creations, 0);
  assert.equal(active, null);
});
