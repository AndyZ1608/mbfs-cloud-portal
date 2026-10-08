import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { translate } from '../src/i18n/index.js';

test('enabled Billing keeps a localized unavailable state when its service fails', async () => {
  const vite = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' });
  try {
    const { errorMessage } = await vite.ssrLoadModule('/src/pages/Billing.jsx');
    for (const locale of ['vi', 'en']) {
      const t = (key) => translate(locale, key);
      assert.equal(errorMessage({ status: 503, code: 'billing_unavailable' }, t), t('billing.unavailable'));
      assert.equal(errorMessage({ status: 504, code: 'billing_timeout' }, t), t('billing.unavailable'));
      assert.equal(errorMessage({ status: 403, code: 'billing_forbidden' }, t), t('billing.noAccess'));
    }
  } finally { await vite.close(); }
});
