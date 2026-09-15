import { Router } from 'express';
import { SSO, ssoConfigError } from '../oidc.js';
import { W as WEBSSO, webssoOn, webssoError } from './websso.js';
import { passwordAuth, listProjects, scopeToken, OSError, MOCK } from '../openstack.js';

const router = Router();

router.get('/config', (req, res) => {
  res.json({
    cloudName: process.env.CLOUD_NAME || 'MBFS Cloud',
    defaultDomain: process.env.OS_DEFAULT_DOMAIN || 'Default',
    mock: MOCK,
    websso: webssoOn(),
    webssoLabel: WEBSSO.label,
    webssoError: WEBSSO.enabled ? webssoError() : null,
    sso: SSO.enabled && !ssoConfigError(),
    ssoLabel: SSO.buttonLabel,
    ssoError: SSO.enabled ? ssoConfigError() : null,
    allowLocal: SSO.allowLocal,
  });
});

router.post('/login', async (req, res, next) => {
  try {
    if ((SSO.enabled || WEBSSO.enabled) && !SSO.allowLocal && !(ssoConfigError() && webssoError())) {
      throw new OSError(403, 'Hệ thống chỉ cho phép đăng nhập bằng SSO');
    }
    const { username, password, domain, project } = req.body || {};
    if (!username || !password) throw new OSError(400, 'Vui lòng nhập tài khoản và mật khẩu');
    const dom = domain || process.env.OS_DEFAULT_DOMAIN || 'Default';

    const { token: unscopedToken } = await passwordAuth(username, password, dom);
    const projects = await listProjects(unscopedToken);
    if (!projects.length) throw new OSError(403, 'Tài khoản chưa được gán vào project nào — liên hệ quản trị viên');

    let target = projects[0];
    if (project) {
      const found = projects.find((p) => p.name === project || p.id === project);
      if (!found) throw new OSError(404, `Không tìm thấy project "${project}" của tài khoản này`);
      target = found;
    }

    const scoped = await scopeToken(unscopedToken, target.id);
    req.session.os = {
      token: scoped.token,
      unscopedToken,
      expiresAt: scoped.expires,
      user: scoped.user,
      project: scoped.project,
      projects: projects.map((p) => ({ id: p.id, name: p.name })),
      catalog: scoped.catalog,
      roles: scoped.roles || [],
    };
    console.log(`[auth] LOGIN user=${scoped.user.name} project=${scoped.project.name}`);
    res.json({ user: scoped.user, project: scoped.project, projects: req.session.os.projects, roles: scoped.roles || [] });
  } catch (e) {
    next(e);
  }
});

router.post('/switch-project', async (req, res, next) => {
  try {
    const sess = req.session.os;
    if (!sess) throw new OSError(401, 'Chưa đăng nhập');
    if (sess.auth_mode === 'sso') throw new OSError(400, 'Phiên SSO — dùng /auth/sso/switch-project');
    const { projectId } = req.body || {};
    const target = sess.projects.find((p) => p.id === projectId);
    if (!target) throw new OSError(404, 'Project không hợp lệ');
    const scoped = await scopeToken(sess.unscopedToken, target.id);
    Object.assign(sess, {
      token: scoped.token,
      expiresAt: scoped.expires,
      project: scoped.project,
      catalog: scoped.catalog,
      roles: scoped.roles || [],
    });
    console.log(`[auth] SWITCH user=${sess.user.name} -> project=${scoped.project.name}`);
    res.json({ project: scoped.project });
  } catch (e) {
    next(e);
  }
});

router.get('/session', (req, res) => {
  const sess = req.session.os;
  if (!sess) return res.status(401).json({ error: 'Chưa đăng nhập' });
  res.json({ user: sess.user, project: sess.project, projects: sess.projects, roles: sess.roles || [], auth_mode: sess.auth_mode || 'keystone', expiresAt: sess.expiresAt });
});

router.post('/logout', (req, res) => {
  const name = req.session.os?.user?.name;
  req.session.destroy(() => {
    if (name) console.log(`[auth] LOGOUT user=${name}`);
    res.json({ ok: true, redirect: process.env.OS_WEBSSO_LOGOUT_URL || null });
  });
});

export default router;
