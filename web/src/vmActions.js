import { canFinalizeResize, canStartResize } from './resize.js';

// Presentation metadata only. The handlers and availability rules remain those of Instances.
export function vmActionItems(server, { t, pendingResize = false, handlers }) {
  const active = server.status === 'ACTIVE';
  const finalizing = canFinalizeResize(server, pendingResize);
  const actions = [
    { key: 'console', labelKey: 'instances.console', group: 'normal' },
    { key: 'changePassword', labelKey: 'instances.changePassword', group: 'normal' },
    { key: 'rename', labelKey: 'instances.rename', group: 'normal' },
    { key: 'networkCards', labelKey: 'instances.networkCards', group: 'normal' },
    { key: 'securityGroups', labelKey: 'instances.securityGroups', group: 'normal' },
    { key: 'floatingIp', labelKey: 'instances.floatingIp', group: 'normal' },
    { key: 'snapshot', labelKey: 'instances.snapshot', group: 'normal' },
    { key: 'start', labelKey: 'instances.start', group: 'lifecycle',
      when: !['ACTIVE', 'VERIFY_RESIZE', 'RESIZE', 'RESIZE_MIGRATING'].includes(server.status) },
    { key: 'stop', labelKey: 'instances.stop', group: 'lifecycle', tone: 'danger', when: active },
    { key: 'softReboot', labelKey: 'instances.softReboot', group: 'lifecycle', tone: 'danger', when: active },
    { key: 'hardReboot', labelKey: 'instances.hardReboot', group: 'lifecycle', tone: 'danger', when: active },
    { key: 'resize', labelKey: 'instances.resize', group: 'lifecycle', tone: 'danger',
      when: canStartResize(server, pendingResize) },
    { key: 'confirmResize', labelKey: 'instances.confirmResize', group: 'lifecycle', when: finalizing },
    { key: 'revertResize', labelKey: 'instances.revertResize', group: 'lifecycle', tone: 'danger', when: finalizing },
    { key: 'shelve', labelKey: 'instances.shelve', group: 'lifecycle', tone: 'danger', when: active },
    { key: 'unshelve', labelKey: 'instances.unshelve', group: 'lifecycle', when: ['SHELVED', 'SHELVED_OFFLOADED'].includes(server.status) },
    { key: 'rebuild', labelKey: 'instances.rebuild', group: 'lifecycle', tone: 'danger',
      when: active || server.status === 'SHUTOFF' },
    { key: 'delete', labelKey: 'instances.delete', group: 'delete', tone: 'destructive' },
  ];
  const items = [];
  let lastGroup;
  for (const action of actions) {
    if (action.when === false) continue;
    if (lastGroup && action.group !== lastGroup) items.push('divider');
    items.push({ key: action.key, label: t(action.labelKey), tone: action.tone, onClick: handlers[action.key] });
    lastGroup = action.group;
  }
  return items;
}
