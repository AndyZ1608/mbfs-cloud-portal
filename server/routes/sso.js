// sso.js — Luồng đăng nhập SSO Keycloak (chế độ cầu nối)
// Keycloak xác thực NGƯỜI DÙNG; quyền gọi OpenStack dùng tài khoản dịch vụ
// OS_TASK_* (Keystone chưa federation). Project khả dụng = nhóm Keycloak
// (os-<project>) giao với project mà tài khoản dịch vụ nhìn thấy.
import { Router } from 'express';
import { OSError } from '../openstack.js';
import { SSO, ssoConfigError, newPkce, authorizeUrl, exchangeCode, verifyIdToken, logoutUrl, groupsFrom, projectNamesFrom } from '../oidc.js';
import { getServiceSession, getServiceProjects, svcConfigured } from '../svcauth.js';
import { record } from '../audit.js';

const router = Router();

const enabled = () => SSO.enabled && !ssoConfigError();

router.get('/auth/sso/config', (req, res) => {
  res.json({
    enabled: enabled(),
    label: SSO.buttonLabel,
    allowLocal: SSO.allowLocal,
    error: SSO.enabled ? ssoConfigError() : null,
  });
});

router.get('/auth/sso/login', async (req, res) => {
  try {
    if (!enabled()) throw new Error(ssoConfigError() || 'SSO chưa được bật');
    if (!svcConfigured()) throw new Error('SSO cần tài khoản dịch vụ OS_TASK_USERNAME/OS_TASK_PASSWORD để gọi OpenStack');
    const pk = newPkce();
    req.session.pkce = { verifier: pk.verifier, state: pk.state, nonce: pk.nonce, at: Date.now() };
    res.redirect(await authorizeUrl(pk));
  } catch (e) {
    res.redirect('/login?sso_error=' + encodeURIComponent(e.message));
  }
});

router.get('/auth/sso/callback', async (req, res) => {
  const fail = (msg, user = null) => {
    record({ user, project: null, method: 'GET', path: '/auth/sso/callback', status: 403, ms: 0 });
    res.redirect('/login?sso_error=' + encodeURIComponent(msg));
  };
  try {
    if (!enabled()) return fail('SSO chưa được bật');
    const { code, state, error, error_description } = req.query;
    if (error) return fail(`Keycloak trả lỗi: ${error_description || error}`);
    const pk = req.session.pkce;
    if (!pk || !state || state !== pk.state) return fail('State không khớp — thử đăng nhập lại');
    if (Date.now() - pk.at > 10 * 60000) return fail('Phiên đăng nhập SSO quá hạn — thử lại');
    delete req.session.pkce;
    if (!code) return fail('Thiếu authorization code');

    const tok = await exchangeCode(code, pk.verifier);
    const claims = await verifyIdToken(tok.id_token, pk.nonce);
    const username = claims.preferred_username || claims.email || claims.sub;

    // Ánh xạ nhóm Keycloak → project OpenStack
    const groups = groupsFrom(claims);
    const wanted = projectNamesFrom(groups);
    if (!wanted.length) {
      return fail(`Tài khoản "${username}" chưa thuộc nhóm project nào trên Keycloak (cần nhóm dạng ${SSO.projectPrefix}<tên-project>)`, username);
    }
    const all = await getServiceProjects();
    const allowed = all.filter((p) => wanted.includes(p.name));
    if (!allowed.length) {
      return fail(`Không có project nào khớp nhóm Keycloak (${wanted.join(', ')}). Kiểm tra tài khoản dịch vụ đã được gán vào các project đó chưa.`, username);
    }

    const target = allowed[0];
    const svc = await getServiceSession(target.id);
    const isAdmin = SSO.adminGroup && groups.includes(SSO.adminGroup);

    req.session.os = {
      token: svc.token,
      expiresAt: null,
      user: { id: claims.sub, name: username, domain: { name: 'keycloak' } },
      project: svc.project,
      projects: allowed.map((p) => ({ id: p.id, name: p.name })),
      catalog: svc.catalog,
      // Quyền admin portal do nhóm Keycloak quyết định; API admin vẫn cần tài
      // khoản dịch vụ có role admin thật trong Keystone.
      roles: isAdmin ? ['admin', 'member'] : ['member'],
      auth_mode: 'sso',
      sso: { idToken: tok.id_token, groups, email: claims.email || null, name: claims.name || null },
    };
    record({ user: username, project: { id: svc.project.id, name: svc.project.name }, method: 'POST', path: '/auth/sso/login', status: 200, ms: 0 });
    console.log(`[sso] LOGIN user=${username} groups=[${groups.join(',')}] project=${svc.project.name} admin=${!!isAdmin}`);
    res.redirect('/');
  } catch (e) {
    console.warn('[sso] callback lỗi:', e.message);
    fail(e.message);
  }
});

// Đăng xuất khỏi cả Keycloak (RP-initiated logout)
router.post('/auth/sso/logout', async (req, res) => {
  const idToken = req.session?.os?.sso?.idToken;
  const url = idToken ? await logoutUrl(idToken) : null;
  req.session.destroy(() => res.json({ ok: true, redirect: url }));
});

// Đổi project cho phiên SSO (không có unscoped token của người dùng)
router.post('/auth/sso/switch-project', async (req, res, next) => {
  try {
    const sess = req.session.os;
    if (!sess || sess.auth_mode !== 'sso') throw new OSError(400, 'Phiên không phải SSO');
    const target = sess.projects.find((p) => p.id === req.body?.projectId);
    if (!target) throw new OSError(403, 'Project không nằm trong nhóm Keycloak của bạn');
    const svc = await getServiceSession(target.id);
    sess.token = svc.token;
    sess.project = svc.project;
    sess.catalog = svc.catalog;
    console.log(`[sso] SWITCH user=${sess.user.name} -> project=${svc.project.name}`);
    res.json({ project: svc.project });
  } catch (e) { next(e); }
});

export default router;
