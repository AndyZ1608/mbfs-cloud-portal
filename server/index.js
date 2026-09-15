import { createApp } from './app.js';
import { config, validateConfig } from './config.js';
import { startReport } from './report.js';
import { startMonitor } from './monitor.js';
import { startPower } from './power.js';
import { startScheduler } from './scheduler.js';
import { startAlerts } from './alerts.js';
import { MOCK } from './openstack.js';

for (const warning of validateConfig()) console.warn(`[config] ${warning}`);

const app = createApp();
startScheduler();
startPower();
startMonitor();
startReport();
startAlerts();

const server = app.listen(config.port, () => {
  console.log(`MBFS Cloud Portal chạy tại http://0.0.0.0:${config.port}${MOCK ? '  (CHẾ ĐỘ MOCK — dữ liệu giả lập)' : ''}`);
  if (!MOCK) console.log(`OS_AUTH_URL=${process.env.OS_AUTH_URL || '(chưa cấu hình!)'}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`[shutdown] Nhận ${signal} — đóng server…`);
    server.close(() => { console.log('[shutdown] Đã đóng, thoát.'); process.exit(0); });
    setTimeout(() => { console.warn('[shutdown] Hết thời gian chờ, thoát cưỡng bức.'); process.exit(1); }, 15000).unref();
  });
}

