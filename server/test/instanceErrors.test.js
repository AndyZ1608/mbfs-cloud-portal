import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyInstanceError, faultImageId, preflightImageFlavor, publicServer, publicServerPayload } from '../instanceErrors.js';
import { bootVolumeSizeWarning, minimumBootVolumeGiB } from '../../shared/imageSize.mjs';

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

test('specific image virtual-size mismatch beats InvalidBDM and BuildAbort wrappers', () => {
  const imageId = 'f6c2af33-0422-47b2-8704-e365db52fefa';
  const requestId = 'req-4579b8e7-19d4-44b5-9627-542f5ea7e8ad';
  const server = { id: 'af94c866-9848-4022-a44a-eddd23891c6d', status: 'ERROR', fault: { code: 'BLOCK_DEVICE_MAPPING_FAILED',
    message: `BuildAbortException: InvalidBDM: Image ${imageId} is unacceptable: Image virtual size is 37GB and doesn't fit in a volume of size 26GB. (Request-ID: ${requestId})`,
    details: 'Traceback File "/var/lib/kolla/venv/lib/python3.12/site-packages/nova/compute.py" '
      + 'nova.exception.InvalidBDM cinderclient.exceptions.BadRequest password=SUPER_SECRET '
      + 'X-Auth-Token: SECRET_TOKEN rabbit://user:pass@internal-rabbit/ internal-compute-host.example',
    created: '2026-09-28T07:31:35Z' } };
  assert.deepEqual(classifyInstanceError(server), { code: 'IMAGE_SIZE_EXCEEDS_VOLUME', category: 'storage', severity: 'error',
    context: { required_disk_gb: 37, requested_volume_gb: 26 },
    occurred_at: '2026-09-28T07:31:35.000Z', request_id: requestId });
  assert.equal(faultImageId(server), imageId);
  for (const fragment of ['/var/lib/kolla', 'site-packages', 'nova.exception', 'cinderclient',
    'SUPER_SECRET', 'SECRET_TOKEN', 'rabbit://', 'internal-compute-host']) {
    assert.equal(JSON.stringify(classifyInstanceError(server)).includes(fragment), false, fragment);
  }
  assert.equal(classifyInstanceError({ status: 'ERROR', fault: { message: 'InvalidBDM: generic failure' } }).code,
    'BLOCK_DEVICE_MAPPING_FAILED');
  assert.equal(classifyInstanceError({ status: 'ERROR', fault: { message: 'BuildAbortException: InvalidBDM',
    details: 'Traceback: Image virtual size is 37GB and does not fit in a volume of size 26GB' } }).code,
  'IMAGE_SIZE_EXCEEDS_VOLUME');
  assert.equal(classifyInstanceError({ status: 'ERROR', fault: { message: 'Image virtual size is 26GB and does not fit in a volume of size 26GB' } }).code,
    'UNKNOWN_INSTANCE_ERROR');
  assert.equal(classifyInstanceError({ status: 'ERROR', fault: { message: 'InvalidBDM: Request-ID: req-12345678-token=secret' } }).request_id,
    undefined);
  assert.equal(classifyInstanceError({ status: 'ERROR', fault: { message: 'BuildAbortException: Image virtual size: 37.2 GiB, and does not fit into a volume of size 37 GiB' } }).context.required_disk_gb, 38);
});

test('Glance virtual_size bytes round up to Cinder integer GiB and combine with min_disk', () => {
  const gib = 1024 ** 3;
  assert.equal(minimumBootVolumeGiB({ virtual_size: 37 * gib }), 37);
  assert.equal(minimumBootVolumeGiB({ virtual_size: 37 * gib + 1 }), 38);
  assert.equal(minimumBootVolumeGiB({ virtual_size: String(37 * gib + 1), min_disk: 40 }), 40);
  assert.equal(minimumBootVolumeGiB({ min_disk: 26 }), 26);
  assert.equal(minimumBootVolumeGiB({ size: 100 * gib }), null);
  assert.deepEqual(bootVolumeSizeWarning({ virtual_size: 37 * gib }, 26), {
    code: 'IMAGE_SIZE_EXCEEDS_VOLUME', context: { required_disk_gb: 37, requested_volume_gb: 26 },
  });
  assert.equal(bootVolumeSizeWarning({ virtual_size: 37 * gib }, 37), null);
  assert.equal(bootVolumeSizeWarning({ virtual_size: 37 * gib }, 0), null);
  assert.equal(preflightImageFlavor({ virtual_size: 37 * gib }, { disk: 0, ram: 4096 },
    { bootFromVolume: true, bootVolumeGiB: 26 }).code, 'IMAGE_SIZE_EXCEEDS_VOLUME');
  assert.equal(preflightImageFlavor({ virtual_size: 37 * gib }, { disk: 0, ram: 4096 },
    { bootFromVolume: true, bootVolumeGiB: 37 }), null);
});
