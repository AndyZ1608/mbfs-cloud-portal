import { Router } from 'express';
import { config } from '../config.js';
import { createBillingService } from '../billing/service.js';
import { BillingError } from '../billing/errors.js';

const router = Router();
const billing = createBillingService();

function service() {
  if (!config.billing.enabled || !billing) {
    throw new BillingError(503, 'billing_disabled', 'Tích hợp Billing chưa được bật');
  }
  return billing;
}

router.get('/billing', async (req, res, next) => {
  try { res.json(await service().summary(req.session.os, req.id)); }
  catch (error) { next(error); }
});

router.get('/billing/instances', async (req, res, next) => {
  try { res.json(await service().instances(req.session.os, req.id)); }
  catch (error) { next(error); }
});

router.get('/billing/instances/:instanceId', async (req, res, next) => {
  try { res.json(await service().instance(req.session.os, req.params.instanceId, req.id)); }
  catch (error) { next(error); }
});

export default router;
