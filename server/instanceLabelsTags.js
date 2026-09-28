import { OSError, osFetch } from './openstack.js';
import { fetchOwned } from './projectScope.js';

export const LABEL_PREFIX = 'cmp.label.';
const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const invalid = (code, message) => new OSError(400, message, code);

export function normalizeLabels(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalid('label_invalid', 'Labels phải là các cặp khóa và giá trị.');
  }
  const labels = Object.create(null);
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = rawKey.trim().toLowerCase();
    if (!key || key.startsWith('cmp.') || !KEY_PATTERN.test(key)
      || Buffer.byteLength(LABEL_PREFIX + key) > 255) {
      throw invalid('label_invalid', 'Khóa Label không hợp lệ.');
    }
    if (Object.hasOwn(labels, key)) throw invalid('label_duplicate', 'Khóa Label bị trùng.');
    if (typeof rawValue !== 'string' || !rawValue.trim() || Buffer.byteLength(rawValue) > 255) {
      throw invalid('label_invalid', 'Giá trị Label không hợp lệ.');
    }
    labels[key] = rawValue;
  }
  return labels;
}

export function normalizeTags(input) {
  if (!Array.isArray(input) || input.length > 50) throw invalid('tag_invalid', 'Danh sách Tag không hợp lệ.');
  const tags = [];
  const seen = new Set();
  for (const raw of input) {
    if (typeof raw !== 'string' || !raw.trim()
      || raw.includes('/') || raw.includes(',') || [...raw].length > 60) {
      throw invalid('tag_invalid', 'Tag không hợp lệ.');
    }
    // Nova tags are case-sensitive; keep the user's exact spelling.
    if (seen.has(raw)) throw invalid('tag_duplicate', 'Tag bị trùng.');
    seen.add(raw);
    tags.push(raw);
  }
  return tags;
}

export function labelsFromMetadata(metadata) {
  const labels = Object.create(null);
  for (const [key, value] of Object.entries(metadata || {})) {
    if (key.startsWith(LABEL_PREFIX) && key.length > LABEL_PREFIX.length) {
      labels[key.slice(LABEL_PREFIX.length)] = value;
    }
  }
  return labels;
}

export function labelsToMetadata(labels) {
  return Object.fromEntries(Object.entries(labels).map(([key, value]) => [LABEL_PREFIX + key, value]));
}

export function labelTagDiff(currentLabels, currentTags, labels, tags) {
  const added = Object.keys(labels).filter((key) => !Object.hasOwn(currentLabels, key));
  const changed = Object.keys(labels).filter((key) => Object.hasOwn(currentLabels, key) && currentLabels[key] !== labels[key]);
  const removed = Object.keys(currentLabels).filter((key) => !Object.hasOwn(labels, key));
  const tagAdded = tags.filter((tag) => !currentTags.includes(tag));
  const tagRemoved = currentTags.filter((tag) => !tags.includes(tag));
  return { labels: { added, changed, removed }, tags: { added: tagAdded, removed: tagRemoved } };
}

export async function getInstanceLabelsTags(session, id) {
  const server = await fetchOwned(session, 'compute', `/servers/${encodeURIComponent(id)}`, 'server');
  const path = `/servers/${encodeURIComponent(id)}`;
  const [metadata, tags] = await Promise.all([
    osFetch(session, 'compute', `${path}/metadata`),
    osFetch(session, 'compute', `${path}/tags`),
  ]);
  return { server, labels: labelsFromMetadata(metadata.metadata), tags: tags.tags || [] };
}

export async function updateInstanceLabelsTags(session, id, input) {
  const labels = normalizeLabels(input?.labels);
  const tags = normalizeTags(input?.tags);
  // Fresh Nova state, never a stale browser snapshot. Ownership is checked first.
  const current = await getInstanceLabelsTags(session, id);
  if (input?.expected) {
    const expected = { labels: normalizeLabels(input.expected.labels), tags: normalizeTags(input.expected.tags) };
    const drift = labelTagDiff(expected.labels, expected.tags, current.labels, current.tags);
    if (Object.values(drift.labels).some((items) => items.length)
      || drift.tags.added.length || drift.tags.removed.length) {
      throw new OSError(409, 'Labels/Tags đã thay đổi ở Nova. Tải lại trước khi lưu.', 'labels_tags_stale');
    }
  }
  const diff = labelTagDiff(current.labels, current.tags, labels, tags);
  const path = `/servers/${encodeURIComponent(id)}`;
  const changedMetadata = labelsToMetadata(Object.fromEntries(
    [...diff.labels.added, ...diff.labels.changed].map((key) => [key, labels[key]])));
  try {
    if (Object.keys(changedMetadata).length) {
      // POST merges individual keys; PUT /metadata would destroy unrelated metadata.
      await osFetch(session, 'compute', `${path}/metadata`, { method: 'POST', body: { metadata: changedMetadata } });
    }
    for (const key of diff.labels.removed) {
      await osFetch(session, 'compute', `${path}/metadata/${encodeURIComponent(LABEL_PREFIX + key)}`, { method: 'DELETE' });
    }
    for (const tag of diff.tags.removed) {
      await osFetch(session, 'compute', `${path}/tags/${encodeURIComponent(tag)}`, { method: 'DELETE' });
    }
    for (const tag of diff.tags.added) {
      await osFetch(session, 'compute', `${path}/tags/${encodeURIComponent(tag)}`, { method: 'PUT', responseType: 'none' });
    }
  } catch (error) {
    if (error.status === 401) throw new OSError(401, 'Phiên OpenStack đã hết hạn.', 'authentication_required');
    if (error.status === 403) throw new OSError(403, 'Nova từ chối quyền cập nhật Labels/Tags.', 'permission_denied');
    throw new OSError(502, 'Cập nhật Labels/Tags chưa hoàn tất. Tải lại trạng thái Nova trước khi thử lại.', 'labels_tags_partial_failure');
  }
  return { server: current.server, labels, tags, diff };
}
