import test from 'node:test';
import assert from 'node:assert/strict';
import { traceNovaConsole } from '../consoleDiagnostics.js';

test('Nova response diagnostics never emit tokens or mutate the forwarded URL', () => {
  const entries = [];
  const url = 'https://user:secret@nova.example/secret/vnc_lite.html?path=%3Ftoken%3Dsecret#secret';
  const response = { remote_console: { url } };
  traceNovaConsole(response, 'test-request', { enabled: true, write: (entry) => entries.push(entry) });
  traceNovaConsole({ console: { url: 'invalid?token=secret' } }, 'test-request', { enabled: true, write: (entry) => entries.push(entry) });
  assert.ok(!JSON.stringify(entries).includes('secret'));
  assert.equal(response.remote_console.url, url);
  assert.equal(entries[0].url, 'https://nova.example/<redacted>/vnc_lite.html?<redacted>#<redacted>');
  assert.equal(entries[1].url, '<invalid URL>');
  traceNovaConsole(response, 'test-request', { enabled: false, write() { assert.fail(); } });
});
