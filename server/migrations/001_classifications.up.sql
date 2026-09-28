CREATE TABLE label_definitions (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, name_key TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (project_id, name_key), UNIQUE (project_id, id)
) STRICT;
CREATE TABLE label_values (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, label_definition_id TEXT NOT NULL,
  value TEXT NOT NULL, value_key TEXT NOT NULL, color TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (label_definition_id, value_key), UNIQUE (project_id, label_definition_id, id),
  FOREIGN KEY (project_id, label_definition_id) REFERENCES label_definitions(project_id, id) ON DELETE CASCADE
) STRICT;
CREATE TABLE tag_definitions (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, name_key TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', color TEXT NOT NULL, created_by TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (project_id, name_key), UNIQUE (project_id, id)
) STRICT;
CREATE TABLE instance_label_assignments (
  project_id TEXT NOT NULL, instance_id TEXT NOT NULL, label_definition_id TEXT NOT NULL,
  label_value_id TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, instance_id, label_definition_id),
  FOREIGN KEY (project_id, label_definition_id, label_value_id)
    REFERENCES label_values(project_id, label_definition_id, id) ON DELETE CASCADE
) STRICT;
CREATE TABLE instance_tag_assignments (
  project_id TEXT NOT NULL, instance_id TEXT NOT NULL, tag_id TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, instance_id, tag_id),
  FOREIGN KEY (project_id, tag_id) REFERENCES tag_definitions(project_id, id) ON DELETE CASCADE
) STRICT;
CREATE INDEX idx_instance_labels_project_value ON instance_label_assignments(project_id, label_value_id, instance_id);
CREATE INDEX idx_instance_tags_project_tag ON instance_tag_assignments(project_id, tag_id, instance_id);
