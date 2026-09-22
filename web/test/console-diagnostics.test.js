import test from 'node:test';
import assert from 'node:assert/strict';
import { consoleUrlShape, createConsoleDiagnostics, createObservedRfb } from '../src/console/diagnostics.js';
import { createRfbSession } from '../src/console/rfbSession.js';

test('diagnostics redact credentials, query, fragment, unknown path and event text', () => {
  const entries = [];
  const diagnostics = createConsoleDiagnostics(true, (entry) => entries.push(entry));
  diagnostics.begin('https://cmp.example/instances?token=secret', true);
  diagnostics.nova('https://user:secret@nova.example:6080/vnc_lite.html?path=%3Ftoken%3Dsecret');
  diagnostics.endpoint('ws://nova.example/websockify/secret?token=secret#secret', 'https:');
  diagnostics.rfb('securityfailure', { reason: 'secret' });
  diagnostics.rfb('desktopname', { name: 'secret' });
  const socket = new EventTarget();
  diagnostics.observeSocket(socket);
  socket.dispatchEvent(new Event('error'));
  const close = new Event('close');
  Object.assign(close, { code: 1006, wasClean: false, reason: 'token=secret' });
  socket.dispatchEvent(close);
  assert.equal(entries.at(-1).code, 1006);
  assert.equal(entries.at(-1).opened, false);
  assert.equal(entries.at(-1).rfbConnected, false);
  assert.equal(entries.find((entry) => entry.event === 'rfb_endpoint').mixedContent, true);
  assert.ok(!JSON.stringify(entries).includes('secret'));
  assert.equal(consoleUrlShape('invalid?token=secret'), '<invalid URL>');
  assert.equal(createConsoleDiagnostics(false, () => assert.fail()), null);
});

test('instrumentation passes exactly one native socket to RFB and observes handshake before RFB connect', () => {
  const entries = [];
  let sockets = 0;
  class Socket extends EventTarget { constructor(url) { super(); this.url = url; sockets++; } close() {} }
  class Rfb { constructor(target, channel) { this.channel = channel; } }
  const diagnostics = createConsoleDiagnostics(true, (entry) => entries.push(entry));
  diagnostics.begin('https://cmp.example', true);
  const rfb = createObservedRfb(Rfb, {}, 'wss://nova.example/?token=fake', diagnostics, Socket);
  assert.equal(sockets, 1);
  rfb.channel.dispatchEvent(new Event('open'));
  diagnostics.rfb('connect');
  const close = new Event('close');
  Object.assign(close, { code: 1000, wasClean: true, reason: '' });
  rfb.channel.dispatchEvent(close);
  assert.equal(entries.find((entry) => entry.event === 'ws_open').handshake, 'accepted');
  assert.equal(entries.at(-1).rfbConnected, true);
  assert.equal(entries.at(-1).opened, true);
  const count = entries.length;
  rfb.channel.dispatchEvent(new Event('error'));
  assert.equal(entries.length, count, 'socket listeners are removed on close');
  const unobserved = createObservedRfb(Rfb, {}, 'wss://nova.example/?token=fake', null, Socket);
  assert.equal(typeof unobserved.channel, 'string');
  assert.equal(sockets, 1, 'diagnostics-off transport remains owned by noVNC');
});

test('RFB diagnostics report event ordering and redact provider error text', async () => {
  const entries = [];
  const states = [];
  const response = { remote_console: { url: 'https://nova.example/vnc_lite.html?token=fake' } };
  const rfb = new EventTarget();
  rfb.disconnect = () => {};
  const session = createRfbSession({
    target: { replaceChildren() {} }, requestConsole: async () => response,
    parseConsoleUrl: () => 'wss://nova.example/?token=fake', createRfb: () => rfb,
    onState: (state) => states.push(state), onRfb() {},
    onResponse: (received) => assert.equal(received, response),
    onEvent: (name, detail) => entries.push({ name, detail }),
  });
  await session.connect();
  rfb.dispatchEvent(new Event('desktopname'));
  rfb.dispatchEvent(new Event('connect'));
  const close = new Event('disconnect');
  close.detail = { clean: false, reason: 'secret' };
  rfb.dispatchEvent(close);
  assert.deepEqual(entries, [{ name: 'desktopname', detail: undefined }, { name: 'connect', detail: undefined },
    { name: 'disconnect', detail: { clean: false } }]);
  session.dispose();

  const failed = createRfbSession({
    target: { replaceChildren() {} }, requestConsole: async () => { throw new Error('token=secret'); },
    parseConsoleUrl() { assert.fail(); }, createRfb() { assert.fail(); },
    onState: (state) => states.push(state), onRfb() {},
  });
  await failed.connect();
  assert.equal(states.at(-1).status, 'error');
  assert.ok(!JSON.stringify(states).includes('secret'));
  failed.dispose();
});
