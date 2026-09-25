export const emptyAccountPasswordForm = () => ({ currentPassword: '', newPassword: '', confirmPassword: '' });

export const canChangeAccountPassword = (session) => session?.auth_mode === 'keystone';

export function validateAccountPasswordForm({ currentPassword, newPassword, confirmPassword }) {
  if (!currentPassword || !newPassword || !confirmPassword) return 'account.passwordRequired';
  if (newPassword !== confirmPassword) return 'account.passwordMismatch';
  if (newPassword === currentPassword) return 'account.passwordSame';
  return null;
}

export async function submitAccountPassword(form, send) {
  const validation = validateAccountPasswordForm(form);
  if (validation) return { validation };
  await send('/account/change-password', { method: 'POST', body: {
    current_password: form.currentPassword, new_password: form.newPassword,
  } });
  return { success: true };
}
