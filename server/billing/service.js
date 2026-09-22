import { config } from '../config.js';
import { BillingClient } from './client.js';
import { BillingError } from './errors.js';

export class BillingService {
  constructor(client) { this.client = client; }

  context(session, requestId) {
    if (session?.token_source === 'service' || session?.auth_mode === 'sso') {
      throw new BillingError(403, 'billing_user_token_required', 'Billing yêu cầu Keystone token project-scoped của chính người dùng');
    }
    return {
      token: session?.token,
      requestId,
      projectId: session?.project?.id, // logging only; never sent to Billing
    };
  }

  summary(session, requestId) {
    return this.client.get('/api/v1/portal/billing', this.context(session, requestId));
  }

  instances(session, requestId) {
    return this.client.get('/api/v1/portal/billing/instances', this.context(session, requestId));
  }

  instance(session, instanceId, requestId) {
    if (!instanceId) throw new BillingError(400, 'billing_instance_required', 'Thiếu instance ID');
    return this.client.get(`/api/v1/portal/billing/instances/${encodeURIComponent(instanceId)}`, {
      ...this.context(session, requestId), instanceId,
    });
  }
}

export function createBillingService(billingConfig = config.billing, options = {}) {
  if (!billingConfig.enabled) return null;
  return new BillingService(new BillingClient({
    baseUrl: billingConfig.baseUrl,
    timeoutMs: billingConfig.timeoutMs,
    ...options,
  }));
}
