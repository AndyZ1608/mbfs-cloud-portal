export const emptySelection = () => ({ labels: [], tag_ids: [] });
export const emptyClassification = () => ({ labels: [], tags: [] });

export function selectionFromClassification(classification) {
  return { labels: (classification?.labels || []).map((item) => ({ label_id: item.label_id, value_id: item.value_id })),
    tag_ids: (classification?.tags || []).map((item) => item.id) };
}

export function classificationChips(classification, limit = 3) {
  const all = [...(classification?.labels || []).map((item) => ({ id: item.value_id,
    text: item.value, title: `${item.label_name}: ${item.value}`, color: item.color })),
  ...(classification?.tags || []).map((item) => ({ id: item.id, text: item.name, title: item.name, color: item.color }))];
  return { visible: all.slice(0, limit), remaining: Math.max(0, all.length - limit) };
}

export function foregroundForColor(color) {
  if (!/^#[0-9A-Fa-f]{6}$/.test(color || '')) return '#111827';
  const channels = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? '#111827' : '#FFFFFF';
}

export function matchesClassificationFilters(classification, filters) {
  return filters.every((filter) => filter.kind === 'tag'
    ? (classification?.tags || []).some((item) => item.id === filter.tag_id)
    : (classification?.labels || []).some((item) => item.label_id === filter.label_id && item.value_id === filter.value_id));
}

export function matchesClassificationSearch(server, search) {
  const query = search.trim().toLocaleLowerCase();
  if (!query) return true;
  return [server.name || '', ...(server.classification?.labels || []).flatMap((item) => [item.label_name, item.value]),
    ...(server.classification?.tags || []).map((item) => item.name)]
    .some((text) => String(text).toLocaleLowerCase().includes(query));
}
