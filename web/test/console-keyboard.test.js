import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENTER_DELAY_MS, SPEED_PRESETS, UnsupportedConsoleCharacterError,
  mapConsoleCharacter, tokenizeConsoleText,
} from '../src/console/keyboard.js';
import {
  ConsoleSessionUnavailableError, ConsoleTypingBusyError, createConsoleAutoTyper,
} from '../src/console/autoType.js';
import { getNovaConsoleUrl } from '../src/console/novaConsole.js';

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

test('Type does not append Enter and Type + Enter adds exactly one final Enter', () => {
  assert.equal(tokenizeConsoleText('ip -br a', false).at(-1).kind, 'character');
  assert.equal(tokenizeConsoleText('ip -br a', true).filter((token) => token.kind === 'enter').length, 1);
  assert.equal(tokenizeConsoleText('ip -br a\n', true).filter((token) => token.kind === 'enter').length, 1);
});

test('typing sends balanced Shift events and central timing presets are correct', async () => {
  const rfb = mockRfb();
  const delays = [];
  const typer = createConsoleAutoTyper({
    getSession: () => rfb,
    isSessionAvailable: () => true,
    sleep: async (delay) => delays.push(delay),
  });
  await typer.start('A\na', { speed: 'normal' });
  assert.deepEqual(rfb.calls.slice(0, 3), [[0xffe1, 'ShiftLeft', true], [65, 'KeyA'], [0xffe1, 'ShiftLeft', false]]);
  assert.deepEqual(rfb.calls.at(-1), [97, 'KeyA']);
  assert.deepEqual(delays, [SPEED_PRESETS.normal.delayMs, ENTER_DELAY_MS]);
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

test('preserves the complete Nova noVNC client URL without deriving a WebSocket URL', () => {
  const url = 'https://novnc.example:6080/vnc_auto.html?path=websockify%3Ftoken%3Dredacted&extra=keep-me';
  assert.equal(getNovaConsoleUrl({ remote_console: { url } }), url);
  assert.throws(() => getNovaConsoleUrl({ remote_console: {} }), /không trả về URL console/);
});
