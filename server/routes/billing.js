import { Router } from 'express';
import { config } from '../config.js';
import { createBillingService } from '../billing/service.js';
import { BillingError } from '../billing/errors.js';

export function createBillingRouter({ billingConfig = config.billing, billingService = createBillingService(billingConfig) } = {}) {
  const router = Router();
  function service() {
    if (!billingConfig.enabled) {
      throw new BillingError(503, 'billing_disabled', 'Tích hợp Billing chưa được bật');
    }
    if (!billingService) {
      throw new BillingError(503, 'billing_unavailable', 'Dịch vụ Billing hiện không khả dụng');
    }
    return billingService;
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
  return router;
}

export default createBillingRouter();
