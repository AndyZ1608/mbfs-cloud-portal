import { Router } from 'express';
import { config } from '../config.js';
import { fetchOwned } from '../projectScope.js';
import { createMonitoringService, INSTANCE_UUID_RE, MONITORING_RANGES } from '../monitoring/service.js';
import { MonitoringError } from '../monitoring/errors.js';

export function createVmMonitoringRouter({ monitoringConfig = config.monitoring,
  monitoringService = createMonitoringService(monitoringConfig), fetchOwnedInstance = fetchOwned } = {}) {
  const router = Router();
  router.get('/servers/:id/monitoring', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (!monitoringConfig.enabled) throw new MonitoringError(503, 'monitoring_disabled', 'Monitoring chưa được bật.');
      const instanceId = req.params.id;
      if (!INSTANCE_UUID_RE.test(instanceId)) throw new MonitoringError(400, 'monitoring_instance_invalid', 'Instance ID không hợp lệ.');
      const range = req.query.range ?? '1h';
      if (typeof range !== 'string' || !Object.hasOwn(MONITORING_RANGES, range)
        || Object.keys(req.query).some((key) => key !== 'range')) {
        throw new MonitoringError(400, 'monitoring_range_invalid', 'Khoảng thời gian Monitoring không hợp lệ.');
      }
      const session = req.session.os;
      const server = await fetchOwnedInstance(session, 'compute', `/servers/${encodeURIComponent(instanceId)}`, 'server');
      if (typeof server?.id !== 'string' || server.id.toLowerCase() !== instanceId.toLowerCase()) {
        throw new MonitoringError(404, 'resource_not_found', 'Không tìm thấy máy ảo trong project hiện tại.');
      }
      if (!monitoringService) throw new MonitoringError(503, 'monitoring_unavailable', 'Dịch vụ Monitoring hiện không khả dụng.');
      const data = await monitoringService.metrics(instanceId, session.project.id, range, req.id);
      res.json(data);
    } catch (error) { next(error); }
  });
  return router;
}

export default createVmMonitoringRouter();
