// websso.js — Đăng nhập SSO qua Keystone WebSSO federation (đúng chuẩn).
// Luồng giống hệt Horizon: trình duyệt → Keystone (/v3/auth/OS-FEDERATION/.../websso)
// → Keycloak xác thực → Keystone POST token liên kết về portal.
// Token là CỦA CHÍNH NGƯỜI DÙNG → không cần tài khoản dịch vụ, không cần nhóm
// Keycloak: danh sách project lấy thẳng từ Keystone như Horizon.
import { Router } from 'express';
import express from 'express';
import { listProjects, scopeToken, OSError, MOCK } from '../openstack.js';
import { record } from '../audit.js';

const router = Router();

export const W = {
  enabled: String(process.env.OS_WEBSSO_ENABLED || '').toLowerCase() === 'true',
  authUrl: (process.env.OS_AUTH_URL || '').replace(/\/+$/, ''),
  // URL Keystone mà TRÌNH DUYỆT dùng (endpoint public có mod_auth_openidc).
  // Thường khác OS_AUTH_URL (endpoint nội bộ portal gọi server-side).
  browserUrl: (process.env.OS_WEBSSO_URL || '').replace(/\/+$/, ''),
  protocol: process.env.OS_WEBSSO_PROTOCOL || 'openid',
  idp: process.env.OS_WEBSSO_IDP || '',
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
  label: process.env.OS_WEBSSO_LABEL || 'Đăng nhập bằng SSO',
  logoutUrl: process.env.OS_WEBSSO_LOGOUT_URL || '',
};
W.callback = W.publicUrl ? `${W.publicUrl}/api/auth/websso/callback` : '';

export function webssoError() {
  if (!W.enabled) return null;
  const miss = [];
  if (!W.authUrl) miss.push('OS_AUTH_URL');
  if (!W.publicUrl) miss.push('PUBLIC_URL');
  return miss.length ? `Thiếu cấu hình WebSSO: ${miss.join(', ')}` : null;
}
export const webssoOn = () => W.enabled && !webssoError();

function keystoneSsoUrl() {
  const origin = encodeURIComponent(W.callback);
  let base = W.browserUrl || W.authUrl;
  if (!/\/v3$/.test(base)) base += '/v3';   // chấp nhận khai có hoặc không có /v3
  return W.idp
    ? `${base}/auth/OS-FEDERATION/identity_providers/${W.idp}/protocols/${W.protocol}/websso?origin=${origin}`
    : `${base}/auth/OS-FEDERATION/websso/${W.protocol}?origin=${origin}`;
}

router.get('/auth/websso/config', (req, res) => {
  res.json({ enabled: webssoOn(), label: W.label, error: W.enabled ? webssoError() : null });
});

router.get('/auth/websso/login', (req, res) => {
  const err = webssoError();
  if (!W.enabled || err) return res.redirect('/login?sso_error=' + encodeURIComponent(err || 'WebSSO chưa được bật'));
  res.redirect(keystoneSsoUrl());
});

// Keystone POST form-urlencoded { token: <unscoped federated token> } về đây.
// (Cross-site POST nên cookie phiên cũ không kèm theo — ta tạo phiên mới tại đây,
//  giống cách Horizon xử lý /auth/websso/.)
router.post('/auth/websso/callback', express.urlencoded({ extended: false, limit: '64kb' }), async (req, res) => {
  const fail = (msg) => {
    record({ user: null, project: null, method: 'POST', path: '/auth/websso/callback', status: 403, ms: 0 });
    res.redirect('/login?sso_error=' + encodeURIComponent(msg));
  };
  try {
    if (!webssoOn()) return fail('WebSSO chưa được bật trên portal');
    const token = req.body?.token;
    if (!token) return fail('Keystone không trả về token — kiểm tra trusted_dashboard trong keystone.conf');

    const projects = await listProjects(token);
    if (!projects.length) {
      return fail('Tài khoản chưa được gán vào project OpenStack nào (liên hệ quản trị viên)');
    }
    const scoped = await scopeToken(token, projects[0].id);

    req.session.regenerate((e) => {
      if (e) return fail('Không tạo được phiên: ' + e.message);
      req.session.os = {
        unscopedToken: token,
        token: scoped.token,
        expiresAt: scoped.expires,
        user: scoped.user,
        project: scoped.project,
        projects: projects.map((p) => ({ id: p.id, name: p.name })),
        catalog: scoped.catalog,
        roles: scoped.roles || [],
        auth_mode: 'websso',
        token_source: 'user',
      };
      record({ user: scoped.user?.name, project: { id: scoped.project.id, name: scoped.project.name }, method: 'POST', path: '/auth/websso/login', status: 200, ms: 0 });
      console.log(`[websso] LOGIN user=${scoped.user?.name} project=${scoped.project.name} projects=${projects.length}`);
      res.redirect('/');
    });
  } catch (e) {
    console.warn('[websso] callback lỗi:', e.message);
    fail(e.message);
  }
});

export default router;
