import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesExactConfirmation } from '../src/utils/confirmation.js';

test('VM deletion confirmation requires exact name equality', () => {
  const name = 'vm-test-01';
  for (const value of ['', 'vm-test', 'VM-test-01', 'vm-test-01 ', ' vm-test-01']) {
    assert.equal(matchesExactConfirmation(value, name), false, JSON.stringify(value));
  }
  assert.equal(matchesExactConfirmation('vm-test-01', name), true);
});

test('confirmation supports spaces, Unicode, punctuation, and numbers without normalization', () => {
  const name = 'DB Sản xuất_01.example-test';
  assert.equal(matchesExactConfirmation(name, name), true);
  assert.equal(matchesExactConfirmation(name.toLowerCase(), name), false);
  assert.equal(matchesExactConfirmation(`${name} `, name), false);
});

test('non-string confirmation values never match', () => {
  assert.equal(matchesExactConfirmation(null, 'vm-test-01'), false);
  assert.equal(matchesExactConfirmation(undefined, 'vm-test-01'), false);
  assert.equal(matchesExactConfirmation('vm-test-01', null), false);
});
