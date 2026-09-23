import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { matchRoutes } from 'react-router-dom';
import { createServer } from 'vite';
import { CONSOLE_ROUTE, openInstanceConsole } from '../src/console/navigation.js';

test('Console action synchronously opens only an encoded CMP route with no opener', () => {
  const calls = [];
  const previous = globalThis.window;
  globalThis.window = { open: (...args) => calls.push(args) };
  try {
    openInstanceConsole('46d1cba2-a3c6-4c80-b9bd-25d9f1c410ed');
    assert.deepEqual(calls, [['/console/46d1cba2-a3c6-4c80-b9bd-25d9f1c410ed', '_blank', 'noopener,noreferrer']]);
    openInstanceConsole('id/with?query#fragment');
    assert.equal(calls[1][0], '/console/id%2Fwith%3Fquery%23fragment');
    assert.equal(new URL(calls[1][0], 'https://cmp.example').search, '');
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});

test('console route resolves an instance UUID directly without navigation state', () => {
  const id = '46d1cba2-a3c6-4c80-b9bd-25d9f1c410ed';
  const matches = matchRoutes([{ path: CONSOLE_ROUTE }], `/console/${id}`);
  assert.equal(matches[0].params.instanceId, id);
});

test('focused console renders a three-line input, only Clear / Type + Enter, and no Nova link or sidebar', async () => {
  const vite = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' });
  try {
    const { default: VncConsole } = await vite.ssrLoadModule('/src/components/VncConsole.jsx');
    const html = renderToStaticMarkup(React.createElement(VncConsole, { instanceId: 'vm-1', name: 'Ubuntu' }));
    assert.match(html, /Console — Ubuntu/);
    assert.match(html, /rows="3"/);
    assert.match(html, /Xoá nội dung/);
    assert.match(html, /Type \+ Enter/);
    assert.doesNotMatch(html, /<select|Tốc độ|console-speed|>\s*Type\s*<|sidebar|console-modal|href=/);
    assert.equal((html.match(/class="vnc-screen"/g) || []).length, 1);
    assert.equal((html.match(/<button/g) || []).length, 3); // Reconnect, Clear, Type + Enter.
    assert.equal((html.match(/<textarea/g) || []).length, 1);
  } finally {
    await vite.close();
  }
});
