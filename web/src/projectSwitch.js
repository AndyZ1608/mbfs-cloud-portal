export const PROJECT_SWITCH_LANDING_ROUTE = '/instances';

// Switch the server-side scoped session before crossing the navigation boundary.
// A document replacement discards every project-scoped React state value and
// prevents the old resource URL from remaining as the current history entry.
export async function switchProjectContext({ projectId, authMode, request, replace }) {
  const path = authMode === 'sso' ? '/auth/sso/switch-project' : '/auth/switch-project';
  await request(path, { method: 'POST', body: { projectId } });
  replace(PROJECT_SWITCH_LANDING_ROUTE);
}
