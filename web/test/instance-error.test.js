import test from 'node:test';
import assert from 'node:assert/strict';
import { imageFlavorWarning, imageFlavorWarningText, instanceErrorGuidance, instanceErrorTitle } from '../src/instanceError.js';
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
  assert.doesNotMatch(detail, /server\.fault|fault\.message|fault\.details/);
});
