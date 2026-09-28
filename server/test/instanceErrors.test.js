import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyInstanceError, preflightImageFlavor, publicServer, publicServerPayload } from '../instanceErrors.js';

test('Nova fault classification uses fixed codes and never returns provider text', () => {
  const secret = 'X-Auth-Token: secret-token password=private mysql://user:password@db '
    + 'postgresql://db/internal rabbit://secret amqp://secret compute-01.internal 10.2.3.4 /var/lib/nova Traceback';
  const server = { id: 'vm', status: 'ERROR', fault: {
    message: `NoValidHost: ${secret}`, details: secret, created: '2026-09-20T09:30:00Z',
  } };
  assert.deepEqual(classifyInstanceError(server), {
    code: 'NO_VALID_HOST', category: 'scheduling', severity: 'error', occurred_at: '2026-09-20T09:30:00.000Z',
  });
  assert.equal(JSON.stringify(classifyInstanceError(server)).includes(secret), false);
  for (const fragment of ['secret-token', 'password=private', 'mysql://', 'postgresql://', 'rabbit://',
    'amqp://', 'compute-01.internal', '10.2.3.4', '/var/lib/nova', 'Traceback']) {
    assert.equal(JSON.stringify(classifyInstanceError(server)).includes(fragment), false, fragment);
  }
  assert.equal(publicServer(server).fault, undefined);
  assert.equal(publicServerPayload({ server }).server.fault, undefined);
  assert.deepEqual(classifyInstanceError({ status: 'ERROR', fault: { message: secret } }),
    { code: 'UNKNOWN_INSTANCE_ERROR', category: 'unknown', severity: 'error' });
  assert.equal(classifyInstanceError({ status: 'ACTIVE', fault: server.fault }), null);
});

test('structured fault code wins, and known Nova failure families map narrowly', () => {
  assert.equal(classifyInstanceError({ status: 'ERROR', fault: { code: 'QUOTA_EXCEEDED', message: 'NoValidHost' } }).code, 'QUOTA_EXCEEDED');
  assert.equal(classifyInstanceError({ status: 'ERROR', fault: { message: 'NoValidHost', details: 'FlavorDiskTooSmall' } }).code, 'NO_VALID_HOST');
  for (const [signal, code] of [
    ['FlavorDiskTooSmall', 'FLAVOR_DISK_TOO_SMALL'], ['FlavorMemoryTooSmall', 'FLAVOR_RAM_TOO_SMALL'],
    ['PortBindingFailed', 'PORT_BINDING_FAILED'], ['VolumeAttachmentFailed', 'VOLUME_ATTACH_FAILED'],
    ['ImageNotActive', 'IMAGE_UNAVAILABLE'], ['NoMoreFixedIps', 'IP_ALLOCATION_FAILED'],
  ]) assert.equal(classifyInstanceError({ status: 'ERROR', fault: { message: signal } }).code, code);
});

test('image/flavor preflight respects boot-from-volume and zero-disk flavors', () => {
  assert.equal(preflightImageFlavor({ min_disk: 80 }, { disk: 40, ram: 4096 }).code, 'FLAVOR_DISK_TOO_SMALL');
  assert.equal(preflightImageFlavor({ min_disk: 80 }, { disk: 40, ram: 4096 }, { bootFromVolume: true }), null);
  assert.equal(preflightImageFlavor({ min_disk: 80 }, { disk: 0, ram: 4096 }), null);
  assert.equal(preflightImageFlavor({ min_ram: 8192 }, { disk: 0, ram: 4096 }, { bootFromVolume: true }).code, 'FLAVOR_RAM_TOO_SMALL');
});
