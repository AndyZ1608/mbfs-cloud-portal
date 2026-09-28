const PREFIX = 'cmp.label.';
const PRIORITY = ['environment', 'application', 'criticality'];

export function instanceLabels(server) {
  return Object.fromEntries(Object.entries(server?.metadata || {})
    .filter(([key]) => key.startsWith(PREFIX) && key.length > PREFIX.length)
    .map(([key, value]) => [key.slice(PREFIX.length), value]));
}

export function instanceTags(server) {
  return Array.isArray(server?.tags) ? server.tags : [];
}

export function listChips(server, limit = 2) {
  const labels = instanceLabels(server);
  const keys = Object.keys(labels).sort((a, b) => {
    const ai = PRIORITY.indexOf(a);
    const bi = PRIORITY.indexOf(b);
    return (ai < 0 ? PRIORITY.length : ai) - (bi < 0 ? PRIORITY.length : bi) || a.localeCompare(b);
  });
  const all = [...keys.map((key) => ({ kind: 'label', text: `${key}: ${labels[key]}` })),
    ...instanceTags(server).map((tag) => ({ kind: 'tag', text: tag }))];
  return { visible: all.slice(0, limit), remaining: Math.max(0, all.length - limit) };
}

export function matchesInstanceFilters(server, search, filters) {
  const labels = instanceLabels(server);
  const tags = instanceTags(server);
  const query = search.trim().toLowerCase();
  if (query && ![server.name || '', ...Object.keys(labels), ...Object.values(labels), ...tags]
    .some((text) => String(text).toLowerCase().includes(query))) return false;
  return filters.every((filter) => filter.kind === 'tag'
    ? tags.includes(filter.tag)
    : Object.hasOwn(labels, filter.key) && labels[filter.key] === filter.value);
}
