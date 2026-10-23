import test from 'node:test';
import assert from 'node:assert/strict';

test('Placement catalog endpoint preserves its path and uses only the server-side scoped token', async () => {
  const { endpointFor, osFetch } = await import('../openstack.js');
  const catalog = [{ type: 'placement', endpoints: [{ interface: 'public', url: 'https://placement.invalid/placement/' }] }];
  assert.equal(endpointFor(catalog, 'placement'), 'https://placement.invalid/placement');
  const session = { token: 'scoped-token', catalog };
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'https://placement.invalid/placement/resource_providers');
      assert.equal(options.headers['X-Auth-Token'], session.token);
      assert.equal(options.method, 'GET');
      return new Response(JSON.stringify({ resource_providers: [] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    };
    assert.deepEqual(await osFetch(session, 'placement', '/resource_providers'), { resource_providers: [] });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
