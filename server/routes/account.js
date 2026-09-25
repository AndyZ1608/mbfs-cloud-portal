import { Router } from 'express';
import { OSError, changeOwnKeystonePassword } from '../openstack.js';
import { setAccountAudit } from '../audit.js';
import { accountPasswordLimiter } from '../security.js';
import { destroyCmpSession } from './auth.js';

const router = Router();

router.post('/account/change-password', accountPasswordLimiter(), async (req, res, next) => {
  const session = req.session.os;
  res.setHeader('Cache-Control', 'no-store');
  // The session is destroyed after success; retain only safe identity for audit finish.
  res.locals.auditSession = {
    user: { id: session.user?.id, name: session.user?.name },
    project: { id: session.project?.id, name: session.project?.name },
  };
  const auditEvent = { action: 'account.password.change', resourceId: session.user?.id,
    resourceName: session.user?.name, details: {} };
  setAccountAudit(res, auditEvent);
  try {
    if ((session.auth_mode && session.auth_mode !== 'keystone') || session.token_source === 'service') {
      throw new OSError(403, 'Không thể đổi mật khẩu cho tài khoản SSO.', 'account_password_unsupported');
    }
    if (!session.user?.id) throw new OSError(401, 'Phiên đăng nhập không hợp lệ.', 'authentication_required');
    const current = req.body?.current_password;
    const nextPassword = req.body?.new_password;
    if (typeof current !== 'string' || !current || typeof nextPassword !== 'string' || !nextPassword) {
      throw new OSError(400, 'Vui lòng nhập mật khẩu hiện tại và mật khẩu mới.', 'account_password_required');
    }
    if (current === nextPassword) {
      throw new OSError(400, 'Mật khẩu mới phải khác mật khẩu hiện tại.', 'account_password_same');
    }
    await changeOwnKeystonePassword(session, current, nextPassword);
    await destroyCmpSession(req, res);
    res.json({ success: true });
  } catch (error) {
    auditEvent.details.reason = ({
      account_current_password_incorrect: 'incorrect_current_password',
      account_password_rejected: 'provider_rejected',
      account_keystone_unavailable: 'keystone_unavailable',
      account_password_unsupported: 'unsupported',
      account_password_required: 'validation_failed',
      account_password_same: 'validation_failed',
    })[error?.code] || 'request_failed';
    next(error);
  }
});

export default router;
