import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROJECT_SWITCH_LANDING_ROUTE, switchProjectContext } from '../src/projectSwitch.js';

test('successful project switch activates scope before replacing the resource URL', async () => {
  assert.equal(PROJECT_SWITCH_LANDING_ROUTE, '/instances');
  for (const [authMode, path] of [['keystone', '/auth/switch-project'], ['sso', '/auth/sso/switch-project']]) {
    const events = [];
    await switchProjectContext({ projectId: 'project-b', authMode,
      request: async (actualPath, options) => {
        events.push(['request', actualPath, options]);
        await Promise.resolve();
        events.push(['activated']);
      },
      replace: (route) => events.push(['replace', route]),
    });
    assert.deepEqual(events, [
      ['request', path, { method: 'POST', body: { projectId: 'project-b' } }],
      ['activated'],
      ['replace', '/instances'],
    ]);
  }
});

test('failed project switch preserves the current route', async () => {
  const redirects = [];
  await assert.rejects(switchProjectContext({ projectId: 'project-b', authMode: 'keystone',
    request: async () => { throw new Error('switch failed'); },
    replace: (route) => redirects.push(route),
  }), /switch failed/);
  assert.deepEqual(redirects, []);
});

test('central Layout owns project-switch navigation and hides old route while switching', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/components/Layout.jsx', import.meta.url)), 'utf8');
  assert.match(source, /setSwitchingProject\(true\)/);
  assert.match(source, /await switchProjectContext\(/);
  assert.match(source, /window\.location\.replace\(route\)/);
  assert.match(source, /switchingProject \? <div className="boot">/);
  assert.doesNotMatch(source, /window\.location\.reload\(\);\s*\} catch/);
});
