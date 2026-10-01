export const normalizedName = (value) => String(value ?? '').toLocaleLowerCase();

export function matchesResourceName(resource, query) {
  const needle = normalizedName(query).trim();
  return !needle || normalizedName(resource?.name).includes(needle);
}

export function nameSuggestions(resources, query, limit = 8) {
  const needle = normalizedName(query).trim();
  if (!needle) return [];
  const names = new Map();
  for (const resource of resources || []) {
    if (!matchesResourceName(resource, needle)) continue;
    const name = String(resource.name);
    names.set(normalizedName(name), names.get(normalizedName(name)) || name);
  }
  return [...names.values()].sort((a, b) => {
    const aPrefix = normalizedName(a).startsWith(needle);
    const bPrefix = normalizedName(b).startsWith(needle);
    return Number(bPrefix) - Number(aPrefix) || a.localeCompare(b);
  }).slice(0, limit);
}
