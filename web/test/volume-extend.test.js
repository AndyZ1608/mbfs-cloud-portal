import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canExtendVolume, validVolumeExtendSize } from '../../shared/volumeExtend.mjs';
import en from '../src/i18n/locales/en.js';
import vi from '../src/i18n/locales/vi.js';

test('Extend is available only for available and in-use volumes; shrink and fractions are rejected', () => {
  assert.equal(canExtendVolume('available'), true);
  assert.equal(canExtendVolume('in-use'), true);
  for (const status of ['extending', 'attaching', 'detaching', 'deleting', 'maintenance', 'reserved', 'error']) {
    assert.equal(canExtendVolume(status), false, status);
  }
  assert.equal(validVolumeExtendSize(50, 60), true);
  for (const size of [50, 40, 50.5, '60', null]) assert.equal(validVolumeExtendSize(50, size), false);
});

test('Volume list and VM Storage tab use the same Extend policy and hook without changing delete safety', () => {
  const volumes = readFileSync(new URL('../src/pages/Volumes.jsx', import.meta.url), 'utf8');
  const instance = readFileSync(new URL('../src/pages/InstanceDetail.jsx', import.meta.url), 'utf8');
  for (const source of [volumes, instance]) {
    assert.match(source, /canExtendVolume\(.*status\)/);
    assert.match(source, /useVolumeExtend/);
    assert.match(source, /volumeExtend\.extend\(/);
  }
  assert.match(volumes, /disabled: v\.status === 'in-use'/);
  const hook = readFileSync(new URL('../src/useVolumeExtend.js', import.meta.url), 'utf8');
  assert.match(hook, /5000/);
  assert.match(hook, /volumes\.extendRequested/);
});

test('new volume extend feedback and error codes are localized in both languages', () => {
  for (const locale of [en, vi]) {
    for (const key of ['volumes.extendTooSmall', 'volumes.extendSizeInvalid', 'volumes.extendRequested',
      'errors.volume_online_extend_unsupported', 'errors.volume_online_extend_forbidden',
      'errors.volume_online_extend_version_unsupported']) assert.ok(locale[key], key);
  }
});
