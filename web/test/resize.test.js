import test from 'node:test';
import assert from 'node:assert/strict';
import { canStartResize, canFinalizeResize, validResizeFlavor, submitResizeOnce } from '../src/resize.js';

const server = { id: 'vm-1', name: 'test-vm', status: 'ACTIVE', flavor: { id: 'old' } };
const flavors = [{ id: 'new' }, { id: 'another' }];

test('Resize availability follows Nova status and locally pending actions', () => {
  assert.equal(canStartResize(server), true);
  assert.equal(canStartResize({ ...server, status: 'SHUTOFF' }), true);
  for (const status of ['RESIZE', 'RESIZE_MIGRATING', 'VERIFY_RESIZE']) {
    assert.equal(canStartResize({ ...server, status }), false);
  }
  assert.equal(canStartResize(server, true), false);
  assert.equal(canStartResize({ ...server, 'OS-EXT-STS:task_state': 'resize_migrating' }), false);
  assert.equal(canFinalizeResize({ ...server, status: 'VERIFY_RESIZE' }), true);
  assert.equal(canFinalizeResize({ ...server, status: 'VERIFY_RESIZE' }, true), false);
  assert.equal(canFinalizeResize(server), false);
});

test('selected flavor must exist and differ from current flavor', () => {
  assert.equal(validResizeFlavor('new', 'old', flavors), true);
  assert.equal(validResizeFlavor('', 'old', flavors), false);
  assert.equal(validResizeFlavor('old', 'old', [...flavors, { id: 'old' }]), false);
  assert.equal(validResizeFlavor('missing', 'old', flavors), false);
});

test('accepted Resize submits once, then closes, notifies, and refreshes without an error', async () => {
  let release;
  const response = new Promise((resolve) => { release = resolve; });
  const events = [];
  const pending = { current: false };
  let requests = 0;
  const args = {
    pending, server, flavorRef: 'new', currentFlavorId: 'old', flavors,
    request: async (path, options) => {
      requests++;
      assert.equal(path, '/servers/vm-1/action');
      assert.deepEqual(options, { method: 'POST', body: { action: 'resize', flavorRef: 'new' } });
      await response; // CMP HTTP 202 with normalized success; no Nova body is required here.
      return { success: true, accepted: true };
    },
    onStart: () => events.push('loading'),
    onAccepted: () => events.push('close', 'success toast', 'refresh VM'),
    onError: () => events.push('error toast'),
  };
  const first = submitResizeOnce(args);
  assert.equal(pending.current, true);
  assert.equal(await submitResizeOnce(args), false);
  assert.equal(requests, 1);
  release();
  assert.equal(await first, true);
  assert.deepEqual(events, ['loading', 'close', 'success toast', 'refresh VM']);
  assert.equal(pending.current, true); // guarded until modal unmounts
});

test('real Resize API error keeps form retryable and never invokes success callbacks', async () => {
  const events = [];
  const pending = { current: false };
  const args = {
    pending, server, flavorRef: 'new', currentFlavorId: 'old', flavors,
    request: async () => { throw new Error('Không thể resize VM ở trạng thái hiện tại.'); },
    onStart: () => events.push('loading'),
    onAccepted: () => events.push('close'),
    onError: (error) => events.push(error.message),
  };
  assert.equal(await submitResizeOnce(args), false);
  assert.equal(pending.current, false);
  assert.deepEqual(events, ['loading', 'Không thể resize VM ở trạng thái hiện tại.']);
});
