// CMP action codes are stable data. Translate only at display time, and never
// render arbitrary request payloads or unknown detail keys.
const shown = (...values) => values.filter((value) => value !== null && value !== undefined && value !== '' && value !== false);

export function formatActivity(event, t) {
  const code = event.action || '';
  const key = `instance.activity.action.${code}`;
  const translation = t(key);
  const semantic = code.startsWith('instance.') ||
    code === 'post.servers' && /^\/servers\/[^/]+\/action$/.test(event.path || '');
  const action = semantic ? (translation === key ? code || '—' : translation) : null;
  const details = event.details && !Array.isArray(event.details) ? event.details : {};
  let summary = '';
  if (code === 'instance.rename' && details.old_name && details.new_name) {
    summary = `${details.old_name} → ${details.new_name}`;
  } else if (code.startsWith('instance.resize.')) {
    summary = shown(details.old_flavor, details.new_flavor).join(details.new_flavor ? ' → ' : '');
  } else if (code.startsWith('instance.interface.')) {
    summary = shown(details.network_name || details.network_id, details.ip_address,
      details.port_id).join(' · ');
  } else if (code === 'instance.security_groups.change') {
    summary = shown(Array.isArray(details.added) && details.added.length && `${t('instance.activity.added')}: ${details.added.join(', ')}`,
      Array.isArray(details.removed) && details.removed.length && `${t('instance.activity.removed')}: ${details.removed.join(', ')}`).join(' · ');
  } else if (code.startsWith('instance.floating_ip.')) {
    summary = shown(details.floating_ip, details.fixed_ip).join(details.fixed_ip ? ' → ' : '');
  } else if (code.startsWith('instance.volume.')) {
    summary = shown(details.volume_name || details.volume_id, details.device).join(' · ');
  } else if (code === 'instance.snapshot.create') {
    summary = shown(details.snapshot_name, details.image_id || details.snapshot_id).join(' · ');
  } else if (code === 'instance.rebuild') {
    summary = details.image_name || details.image_id || '';
  } else if (code === 'instance.create') {
    summary = shown(details.flavor_name || details.flavor_id, details.image_name || details.image_id,
      details.interface_count != null && t('instance.activity.interfaceCount', { count: details.interface_count })).join(' · ');
  } else if (Array.isArray(details.interfaces) && details.interfaces.length) {
    const first = details.interfaces[0];
    summary = shown(first.fixed_ip, first.port_id).join(' · ');
  }
  const resultKey = `instance.activity.result.${event.result}`;
  const resultLabel = t(resultKey);
  return { semantic, action, details: summary,
    result: resultLabel === resultKey ? event.result || '—' : resultLabel };
}
