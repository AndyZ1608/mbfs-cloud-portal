import test from 'node:test';
import assert from 'node:assert/strict';
import { imageFlavorWarning, imageFlavorWarningText, instanceErrorDescription, instanceErrorGuidance,
  instanceErrorTitle, minimumBootVolumeGiB, safeVolumeContext } from '../src/instanceError.js';
import { translate } from '../src/i18n/index.js';
import { formatActivity } from '../src/activityFormatter.js';
import { apiErrorMessage } from '../src/api.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

test('safe instance errors have Vietnamese and English customer-facing text', () => {
  for (const locale of ['vi', 'en']) {
    const t = (key, values) => translate(locale, key, values);
    assert.notEqual(instanceErrorTitle(t, 'NO_VALID_HOST'), 'instance.error.code.NO_VALID_HOST');
    assert.notEqual(instanceErrorGuidance(t, 'NO_VALID_HOST'), 'instance.error.guidance.scheduling');
    assert.equal(instanceErrorTitle(t, 'token=secret'), instanceErrorTitle(t, 'UNKNOWN_INSTANCE_ERROR'));
    const event = formatActivity({ action: 'instance.error.detected', result: 'failure',
      details: { error_code: 'PORT_BINDING_FAILED', raw: 'password=private' } }, t);
    assert.equal(JSON.stringify(event).includes('private'), false);
    assert.equal(event.details, instanceErrorTitle(t, 'PORT_BINDING_FAILED'));
  }
});

test('create warning checks image requirements without treating zero disk or BFV as too small', () => {
  const t = (key, values) => translate('en', key, values);
  const image = { min_disk: 80, min_ram: 4096 };
  assert.equal(imageFlavorWarning(image, { disk: 20, ram: 2048 }).code, 'FLAVOR_RAM_TOO_SMALL');
  const warning = imageFlavorWarning(image, { disk: 20, ram: 8192 });
  assert.equal(warning.code, 'FLAVOR_DISK_TOO_SMALL');
  assert.match(imageFlavorWarningText(t, warning), /80 GB/);
  assert.equal(imageFlavorWarning(image, { disk: 20, ram: 8192 }, true), null);
  assert.equal(imageFlavorWarning(image, { disk: 0, ram: 8192 }), null);
  assert.match(apiErrorMessage({ code: 'FLAVOR_DISK_TOO_SMALL', context: warning.context }, 400), /80 GB/);
});

test('VM list and detail wire safe ERROR diagnostics without raw provider fields', () => {
  const list = readFileSync(fileURLToPath(new URL('../src/pages/Instances.jsx', import.meta.url)), 'utf8');
  const detail = readFileSync(fileURLToPath(new URL('../src/pages/InstanceDetail.jsx', import.meta.url)), 'utf8');
  assert.match(list, /s\.status === 'ERROR'/);
  assert.match(list, /s\.instance_error\?\.code/);
  assert.match(list, /imageFlavorWarning\(/);
  assert.match(detail, /api\(`\/servers\/\$\{encodedId\}\/error`\)/);
  assert.match(detail, /server\.status === 'ERROR'/);
  assert.match(detail, /className="vm-error-card"/);
  assert.match(detail, /instance\.error\.supportReference/);
  assert.match(list, /minimumBootVolumeGiB\(selectedImage\)/);
  assert.doesNotMatch(detail, /server\.fault|fault\.message|fault\.details/);
});

test('37 GiB image and 26 GiB boot volume show specific safe vi/en guidance', () => {
  const image = { min_disk: 0, virtual_size: 37 * 1024 ** 3 };
  assert.equal(minimumBootVolumeGiB(image), 37);
  const warning = imageFlavorWarning(image, { ram: 4096, disk: 0 }, true, 26);
  assert.deepEqual(warning, { code: 'IMAGE_SIZE_EXCEEDS_VOLUME',
    context: { required_disk_gb: 37, requested_volume_gb: 26 } });
  assert.equal(imageFlavorWarning(image, { ram: 4096, disk: 0 }, true, 37), null);
  assert.equal(minimumBootVolumeGiB({ virtual_size: 37 * 1024 ** 3 + 1 }), 38);
  assert.equal(safeVolumeContext({ required_disk_gb: 37, requested_volume_gb: 26 }).required_disk_gb, 37);
  assert.equal(safeVolumeContext(null), null);
  assert.equal(safeVolumeContext(undefined), null);
  assert.equal(safeVolumeContext({ required_disk_gb: '37', requested_volume_gb: 26 }), null);
  for (const locale of ['en', 'vi']) {
    const t = (key, variables) => translate(locale, key, variables);
    assert.match(instanceErrorTitle(t, warning.code), /[Vv]olume/);
    assert.match(instanceErrorDescription(t, warning), /37 GB/);
    assert.match(instanceErrorDescription(t, warning), /26 GB/);
    assert.match(instanceErrorGuidance(t, warning.code, warning.context), /37 GB/);
    assert.match(imageFlavorWarningText(t, warning), /37 GB/);
    const event = formatActivity({ action: 'instance.error.detected', result: 'failure',
      details: { error_code: warning.code, ...warning.context, raw: 'password=SECRET' } }, t);
    assert.match(event.details, /37 GB/);
    assert.equal(JSON.stringify(event).includes('SECRET'), false);
  }
  assert.match(apiErrorMessage({ code: warning.code, context: warning.context }, 400), /37 GB/);
});
