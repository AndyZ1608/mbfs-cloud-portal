import express from 'express';
import session from 'express-session';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import authRoutes from './routes/auth.js';
import computeRoutes from './routes/compute.js';
import networkRoutes from './routes/network.js';
import storageRoutes from './routes/storage.js';
import billingRoutes from './routes/billing.js';
import lbRoutes from './routes/lb.js';
import backupRoutes from './routes/backup.js';
import marketplaceRoutes from './routes/marketplace.js';
import k8sRoutes from './routes/k8s.js';
import adminRoutes from './routes/admin.js';
import ssoRoutes from './routes/sso.js';
import webssoRoutes from './routes/websso.js';
import powerRoutes from './routes/power.js';
import optimizeRoutes from './routes/optimize.js';
import monitorRoutes from './routes/monitor.js';
import objectRoutes from './routes/objectstore.js';
import iacRoutes from './routes/iac.js';
import notifyRoutes from './routes/notify.js';
import { auditMiddleware, auditLogin } from './audit.js';
import { securityHeaders, loginLimiter, apiLimiter } from './security.js';
import { buildSessionStore } from './sessionstore.js';
import { config } from './config.js';
import { requestContext, csrfProtection, requireAuth, errorHandler } from './middleware.js';
import { MOCK } from './openstack.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const protectedRoutes = [
  computeRoutes, networkRoutes, storageRoutes, billingRoutes, lbRoutes,
  backupRoutes, marketplaceRoutes, powerRoutes, optimizeRoutes, monitorRoutes,
  objectRoutes, iacRoutes, notifyRoutes, k8sRoutes, adminRoutes,
];

export function createApp({ sessionStore, sessionSecret } = {}) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);
  app.use(requestContext);
  app.use(securityHeaders);
  app.use(express.json({ limit: '1mb' }));
  app.use(session({
    name: 'mbfs_cloud_sid',
    store: sessionStore === undefined ? buildSessionStore(config.sessionTtlMs / 1000) : sessionStore,
    secret: sessionSecret || config.sessionSecret || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: config.secureCookies, maxAge: config.sessionTtlMs },
  }));

  app.use('/api', (req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      const user = req.session?.os?.user?.name || '-';
      console.log(`${new Date().toISOString()} [api] request_id=${req.id} ${user} ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - started}ms`);
    });
    next();
  });

  app.get('/healthz', (_req, res) => res.json({ ok: true, mock: MOCK }));
  app.use('/api', apiLimiter());
  app.use('/api/auth/login', loginLimiter());
  app.use('/api/auth/sso/login', loginLimiter());
  app.use('/api', csrfProtection);
  app.use('/api', auditMiddleware);
  app.use('/api', ssoRoutes);
  app.use('/api', webssoRoutes);
  app.use('/api/auth/login', auditLogin);
  app.use('/api/auth', authRoutes);
  for (const routes of protectedRoutes) app.use('/api', requireAuth, routes);

  const publicDir = path.join(__dirname, 'public');
  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir));
    app.use((req, res, next) => {
      if (req.method === 'GET' && !req.path.startsWith('/api')) return res.sendFile(path.join(publicDir, 'index.html'));
      next();
    });
  }

  app.use('/api', (req, res) => res.status(404).json({ error: 'Không tìm thấy API', code: 'not_found', requestId: req.id }));
  app.use(errorHandler);
  return app;
}

