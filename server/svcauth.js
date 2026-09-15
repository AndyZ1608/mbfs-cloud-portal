// svcauth.js — phiên OpenStack cho tác vụ nền (backup theo lịch, cảnh báo)
// Dùng tài khoản dịch vụ OS_TASK_USERNAME/OS_TASK_PASSWORD (cần role member
// trên các project liên quan). Ở chế độ MOCK không cần cấu hình.
import { passwordAuth, listProjects, scopeToken, MOCK } from './openstack.js';

const U = process.env.OS_TASK_USERNAME;
const P = process.env.OS_TASK_PASSWORD;
const D = process.env.OS_TASK_DOMAIN || process.env.OS_DEFAULT_DOMAIN || 'Default';

export const svcConfigured = () => MOCK || !!(U && P);

const cache = new Map(); // projectId -> { sess, exp }

export async function getServiceSession(projectId) {
  if (!svcConfigured()) throw new Error('Chưa cấu hình tài khoản dịch vụ (OS_TASK_USERNAME/OS_TASK_PASSWORD)');
  const hit = cache.get(projectId);
  if (hit && hit.exp > Date.now() + 120000) return hit.sess;
  const { token } = await passwordAuth(U || 'portal-task', P || 'x', D);
  const sc = await scopeToken(token, projectId);
  const sess = { token: sc.token, user: sc.user, project: sc.project, catalog: sc.catalog };
  cache.set(projectId, { sess, exp: sc.expires ? Date.parse(sc.expires) : Date.now() + 3600000 });
  return sess;
}

// Danh sách project mà tài khoản dịch vụ nhìn thấy (cho vòng lặp cảnh báo)
export async function getServiceProjects() {
  const { token } = await passwordAuth(U || 'portal-task', P || 'x', D);
  return listProjects(token);
}
