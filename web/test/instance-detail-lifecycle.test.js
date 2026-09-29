import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Outlet, Route, Routes, StaticRouter } from 'react-router-dom';
import { createServer } from 'vite';

test('detail route waits for a project before rendering project-scoped detail', async () => {
  const vite = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' });
  try {
    const { default: InstanceDetailRoute } = await vite.ssrLoadModule('/src/pages/InstanceDetail.jsx');
    const { LocaleProvider } = await vite.ssrLoadModule('/src/i18n/react.jsx');
    const render = (sess) => renderToStaticMarkup(React.createElement(LocaleProvider, null,
      React.createElement(StaticRouter, { location: '/instances/vm-a' },
        React.createElement(Routes, null,
          React.createElement(Route, { element: React.createElement(Outlet, { context: { sess } }) },
            React.createElement(Route, { path: '/instances/:instanceId', element: React.createElement(InstanceDetailRoute) }))))));
    assert.match(render(null), /Loading|Đang tải/);
    assert.match(render({ user: { name: 'user' }, project: undefined }), /Loading|Đang tải/);
    assert.match(render({ user: { name: 'user' }, project: null }), /Loading|Đang tải/);
    assert.match(render({ user: { name: 'user' }, project: { id: 'project-a', name: 'Project A' }, roles: [] }), /Loading|Đang tải/);
  } finally { await vite.close(); }
});
