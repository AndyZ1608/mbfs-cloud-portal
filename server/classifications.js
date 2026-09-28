import { randomUUID } from 'node:crypto';
import { OSError } from './openstack.js';
import { classificationDb, transaction } from './classificationDb.js';

const fail = (status, code, message) => new OSError(status, message, code);
const now = () => new Date().toISOString();
const uniqueError = (error) => {
  if (/UNIQUE constraint failed/.test(error?.message || '')) throw fail(409, 'classification_duplicate', 'Tên hoặc giá trị đã tồn tại trong project.');
  throw error;
};

function humanName(input, kind = 'name') {
  if (typeof input !== 'string') throw fail(400, 'classification_invalid', 'Tên không hợp lệ.');
  const value = input.trim().normalize('NFC');
  if (!value || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw fail(400, 'classification_invalid', 'Tên không hợp lệ.');
  }
  return { value, key: value.toLocaleLowerCase('und') };
}

function description(input) {
  if (input == null) return '';
  if (typeof input !== 'string' || input.length > 500) throw fail(400, 'classification_invalid', 'Mô tả không hợp lệ.');
  return input.trim();
}

export function color(input) {
  if (typeof input !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(input)) {
    throw fail(400, 'classification_color_invalid', 'Màu phải có dạng #RRGGBB.');
  }
  return input.toUpperCase();
}

function dbOf(db) { return db || classificationDb(); }
function scoped(db, table, projectId, id) {
  const row = db.prepare(`SELECT * FROM ${table} WHERE project_id = ? AND id = ?`).get(projectId, id);
  if (!row) throw fail(404, 'resource_not_found', 'Không tìm thấy tài nguyên trong project hiện tại.');
  return row;
}

export function catalog(projectId, dbInput) {
  const db = dbOf(dbInput);
  const labels = db.prepare(`SELECT d.*, (SELECT COUNT(*) FROM instance_label_assignments a
    WHERE a.project_id=d.project_id AND a.label_definition_id=d.id) AS assignment_count
    FROM label_definitions d WHERE project_id=? ORDER BY name_key`).all(projectId);
  const values = db.prepare(`SELECT v.*, (SELECT COUNT(*) FROM instance_label_assignments a
    WHERE a.project_id=v.project_id AND a.label_value_id=v.id) AS assignment_count
    FROM label_values v WHERE project_id=? ORDER BY value_key`).all(projectId);
  const byLabel = new Map(labels.map((label) => [label.id, label]));
  for (const label of labels) label.values = [];
  for (const value of values) byLabel.get(value.label_definition_id)?.values.push(value);
  const tags = db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM instance_tag_assignments a
    WHERE a.project_id=t.project_id AND a.tag_id=t.id) AS assignment_count
    FROM tag_definitions t WHERE project_id=? ORDER BY name_key`).all(projectId);
  return { labels, tags };
}

function validatedValues(values) {
  if (!Array.isArray(values) || !values.length || values.length > 100) {
    throw fail(400, 'classification_invalid', 'Label cần ít nhất một giá trị.');
  }
  const keys = new Set();
  return values.map((item) => {
    const named = humanName(item?.value, 'value');
    if (keys.has(named.key)) throw fail(409, 'classification_duplicate', 'Giá trị Label bị trùng.');
    keys.add(named.key);
    return { id: item?.id, value: named.value, value_key: named.key, color: color(item?.color) };
  });
}

export function createLabel(projectId, actor, input, dbInput) {
  const db = dbOf(dbInput);
  const name = humanName(input?.name);
  const values = validatedValues(input?.values);
  const id = randomUUID(); const ts = now();
  try {
    transaction(db, () => {
      db.prepare(`INSERT INTO label_definitions(id,project_id,name,name_key,description,created_by,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(id, projectId, name.value, name.key, description(input?.description), actor, ts, ts);
      const insert = db.prepare(`INSERT INTO label_values(id,project_id,label_definition_id,value,value_key,color,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?)`);
      for (const item of values) insert.run(randomUUID(), projectId, id, item.value, item.value_key, item.color, ts, ts);
    });
  } catch (error) { uniqueError(error); }
  return catalog(projectId, db).labels.find((item) => item.id === id);
}

export function updateLabel(projectId, id, input, dbInput) {
  const db = dbOf(dbInput);
  scoped(db, 'label_definitions', projectId, id);
  const name = humanName(input?.name);
  const values = validatedValues(input?.values);
  const current = db.prepare('SELECT * FROM label_values WHERE project_id=? AND label_definition_id=?').all(projectId, id);
  const old = new Map(current.map((item) => [item.id, item]));
  const kept = new Set();
  for (const item of values) {
    if (!item.id) continue;
    if (kept.has(item.id)) throw fail(400, 'classification_invalid', 'Giá trị Label bị trùng.');
    if (!old.has(item.id)) throw fail(404, 'resource_not_found', 'Không tìm thấy giá trị Label trong project hiện tại.');
    kept.add(item.id);
  }
  const removed = current.filter((item) => !kept.has(item.id));
  const affected = removed.reduce((count, item) => count + db.prepare(
    'SELECT COUNT(*) AS n FROM instance_label_assignments WHERE project_id=? AND label_value_id=?').get(projectId, item.id).n, 0);
  if (affected && input?.confirm_removals !== true) {
    throw fail(409, 'classification_in_use', 'Giá trị Label đang được gán cho VM; cần xác nhận xoá.');
  }
  const ts = now();
  try {
    transaction(db, () => {
      db.prepare('UPDATE label_definitions SET name=?, name_key=?, description=?, updated_at=? WHERE project_id=? AND id=?')
        .run(name.value, name.key, description(input?.description), ts, projectId, id);
      const edit = db.prepare('UPDATE label_values SET value=?,value_key=?,color=?,updated_at=? WHERE project_id=? AND label_definition_id=? AND id=?');
      const add = db.prepare(`INSERT INTO label_values(id,project_id,label_definition_id,value,value_key,color,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?)`);
      for (const item of removed) db.prepare('DELETE FROM label_values WHERE project_id=? AND id=?').run(projectId, item.id);
      for (const item of values) {
        if (item.id) edit.run(item.value, item.value_key, item.color, ts, projectId, id, item.id);
        else add.run(randomUUID(), projectId, id, item.value, item.value_key, item.color, ts, ts);
      }
    });
  } catch (error) { uniqueError(error); }
  return { label: catalog(projectId, db).labels.find((item) => item.id === id), removedAssignments: affected };
}

export function deleteLabel(projectId, id, confirm, dbInput) {
  const db = dbOf(dbInput);
  const row = scoped(db, 'label_definitions', projectId, id);
  const count = db.prepare('SELECT COUNT(*) AS n FROM instance_label_assignments WHERE project_id=? AND label_definition_id=?').get(projectId, id).n;
  const values = db.prepare('SELECT COUNT(*) AS n FROM label_values WHERE project_id=? AND label_definition_id=?').get(projectId, id).n;
  if (confirm !== true) throw fail(409, 'classification_confirmation_required', 'Cần xác nhận xoá Label.');
  transaction(db, () => db.prepare('DELETE FROM label_definitions WHERE project_id=? AND id=?').run(projectId, id));
  return { name: row.name, assignment_count: count, value_count: values };
}

export function createTag(projectId, actor, input, dbInput) {
  const db = dbOf(dbInput); const name = humanName(input?.name); const id = randomUUID(); const ts = now();
  try {
    db.prepare(`INSERT INTO tag_definitions(id,project_id,name,name_key,description,color,created_by,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(id, projectId, name.value, name.key, description(input?.description), color(input?.color), actor, ts, ts);
  } catch (error) { uniqueError(error); }
  return scoped(db, 'tag_definitions', projectId, id);
}

export function updateTag(projectId, id, input, dbInput) {
  const db = dbOf(dbInput); scoped(db, 'tag_definitions', projectId, id); const name = humanName(input?.name);
  try {
    db.prepare('UPDATE tag_definitions SET name=?,name_key=?,description=?,color=?,updated_at=? WHERE project_id=? AND id=?')
      .run(name.value, name.key, description(input?.description), color(input?.color), now(), projectId, id);
  } catch (error) { uniqueError(error); }
  return scoped(db, 'tag_definitions', projectId, id);
}

export function deleteTag(projectId, id, confirm, dbInput) {
  const db = dbOf(dbInput); const row = scoped(db, 'tag_definitions', projectId, id);
  const count = db.prepare('SELECT COUNT(*) AS n FROM instance_tag_assignments WHERE project_id=? AND tag_id=?').get(projectId, id).n;
  if (confirm !== true) throw fail(409, 'classification_confirmation_required', 'Cần xác nhận xoá Tag.');
  transaction(db, () => db.prepare('DELETE FROM tag_definitions WHERE project_id=? AND id=?').run(projectId, id));
  return { name: row.name, assignment_count: count };
}

export function validateSelection(projectId, input, dbInput) {
  const { labels, tags } = catalog(projectId, dbInput);
  if (!Array.isArray(input?.labels) || !Array.isArray(input?.tag_ids)) {
    throw fail(400, 'classification_invalid', 'Danh sách Labels/Tags không hợp lệ.');
  }
  const labelMap = new Map(labels.map((item) => [item.id, item]));
  const tagMap = new Map(tags.map((item) => [item.id, item]));
  const selectedLabels = new Map();
  for (const item of input.labels) {
    const label = labelMap.get(item?.label_id);
    if (!label || selectedLabels.has(label.id) || !label.values.some((value) => value.id === item.value_id)) {
      throw fail(400, 'classification_invalid', 'Label hoặc giá trị không thuộc project hiện tại.');
    }
    selectedLabels.set(label.id, item.value_id);
  }
  const selectedTags = new Set();
  for (const id of input.tag_ids) {
    if (!tagMap.has(id) || selectedTags.has(id)) throw fail(400, 'classification_invalid', 'Tag không thuộc project hiện tại.');
    selectedTags.add(id);
  }
  return { labels: selectedLabels, tags: selectedTags, catalog: { labels, tags } };
}

export function assignmentsForInstances(projectId, instanceIds, dbInput) {
  const db = dbOf(dbInput);
  const result = Object.fromEntries(instanceIds.map((id) => [id, { labels: [], tags: [] }]));
  for (let offset = 0; offset < instanceIds.length; offset += 500) {
    const ids = instanceIds.slice(offset, offset + 500);
    if (!ids.length) continue;
    const slots = ids.map(() => '?').join(',');
    const rows = db.prepare(`SELECT a.instance_id,d.id AS label_id,d.name AS label_name,v.id AS value_id,v.value,v.color
      FROM instance_label_assignments a JOIN label_definitions d ON d.project_id=a.project_id AND d.id=a.label_definition_id
      JOIN label_values v ON v.project_id=a.project_id AND v.label_definition_id=d.id AND v.id=a.label_value_id
      WHERE a.project_id=? AND a.instance_id IN (${slots}) ORDER BY d.name_key`).all(projectId, ...ids);
    for (const row of rows) result[row.instance_id]?.labels.push({ label_id: row.label_id, label_name: row.label_name,
      value_id: row.value_id, value: row.value, color: row.color });
    const tagRows = db.prepare(`SELECT a.instance_id,t.id,t.name,t.color FROM instance_tag_assignments a
      JOIN tag_definitions t ON t.project_id=a.project_id AND t.id=a.tag_id
      WHERE a.project_id=? AND a.instance_id IN (${slots}) ORDER BY t.name_key`).all(projectId, ...ids);
    for (const row of tagRows) result[row.instance_id]?.tags.push({ id: row.id, name: row.name, color: row.color });
  }
  return result;
}

export function replaceAssignments(projectId, instanceId, input, dbInput) {
  const db = dbOf(dbInput);
  return transaction(db, () => {
    const selected = validateSelection(projectId, input, db);
    const oldLabels = new Map(db.prepare('SELECT label_definition_id,label_value_id FROM instance_label_assignments WHERE project_id=? AND instance_id=?')
      .all(projectId, instanceId).map((item) => [item.label_definition_id, item.label_value_id]));
    const oldTags = new Set(db.prepare('SELECT tag_id FROM instance_tag_assignments WHERE project_id=? AND instance_id=?')
      .all(projectId, instanceId).map((item) => item.tag_id));
    const ts = now();
    for (const [id, valueId] of oldLabels) if (!selected.labels.has(id)) {
      db.prepare('DELETE FROM instance_label_assignments WHERE project_id=? AND instance_id=? AND label_definition_id=?').run(projectId, instanceId, id);
    } else if (selected.labels.get(id) !== valueId) {
      db.prepare('UPDATE instance_label_assignments SET label_value_id=? WHERE project_id=? AND instance_id=? AND label_definition_id=?')
        .run(selected.labels.get(id), projectId, instanceId, id);
    }
    for (const [id, valueId] of selected.labels) if (!oldLabels.has(id)) {
      db.prepare('INSERT INTO instance_label_assignments(project_id,instance_id,label_definition_id,label_value_id,created_at) VALUES(?,?,?,?,?)')
        .run(projectId, instanceId, id, valueId, ts);
    }
    for (const id of oldTags) if (!selected.tags.has(id)) {
      db.prepare('DELETE FROM instance_tag_assignments WHERE project_id=? AND instance_id=? AND tag_id=?').run(projectId, instanceId, id);
    }
    for (const id of selected.tags) if (!oldTags.has(id)) {
      db.prepare('INSERT INTO instance_tag_assignments(project_id,instance_id,tag_id,created_at) VALUES(?,?,?,?)')
        .run(projectId, instanceId, id, ts);
    }
    const labelDefinitions = new Map(selected.catalog.labels.map((item) => [item.id, item]));
    const describeLabel = (id, valueId) => {
      const label = labelDefinitions.get(id);
      const value = label?.values.find((item) => item.id === valueId)?.value;
      return value ? `${label.name}: ${value}` : label?.name || id;
    };
    const tagNames = new Map(selected.catalog.tags.map((item) => [item.id, item.name]));
    const diff = { labels: { added: [], changed: [], removed: [] }, tags: { added: [], removed: [] } };
    for (const [id, valueId] of oldLabels) if (!selected.labels.has(id)) diff.labels.removed.push(describeLabel(id, valueId));
    for (const [id, valueId] of selected.labels) {
      if (!oldLabels.has(id)) diff.labels.added.push(describeLabel(id, valueId));
      else if (oldLabels.get(id) !== valueId) diff.labels.changed.push(`${describeLabel(id, oldLabels.get(id))} → ${describeLabel(id, valueId)}`);
    }
    for (const id of oldTags) if (!selected.tags.has(id)) diff.tags.removed.push(tagNames.get(id));
    for (const id of selected.tags) if (!oldTags.has(id)) diff.tags.added.push(tagNames.get(id));
    return { classification: assignmentsForInstances(projectId, [instanceId], db)[instanceId], diff };
  });
}

export function removeInstanceAssignments(projectId, instanceId, dbInput) {
  const db = dbOf(dbInput);
  transaction(db, () => {
    db.prepare('DELETE FROM instance_label_assignments WHERE project_id=? AND instance_id=?').run(projectId, instanceId);
    db.prepare('DELETE FROM instance_tag_assignments WHERE project_id=? AND instance_id=?').run(projectId, instanceId);
  });
}

export function pruneMissingInstances(projectId, knownIds, dbInput) {
  const db = dbOf(dbInput);
  const known = new Set(knownIds);
  const rows = db.prepare(`SELECT instance_id FROM instance_label_assignments WHERE project_id=?
    UNION SELECT instance_id FROM instance_tag_assignments WHERE project_id=?`).all(projectId, projectId);
  const stale = rows.map((row) => row.instance_id).filter((id) => !known.has(id));
  if (!stale.length) return 0;
  transaction(db, () => {
    const labels = db.prepare('DELETE FROM instance_label_assignments WHERE project_id=? AND instance_id=?');
    const tags = db.prepare('DELETE FROM instance_tag_assignments WHERE project_id=? AND instance_id=?');
    for (const id of stale) { labels.run(projectId, id); tags.run(projectId, id); }
  });
  return stale.length;
}
