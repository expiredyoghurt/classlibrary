ALTER TABLE classes ADD COLUMN last_seen_at TEXT;
ALTER TABLE books ADD COLUMN categories TEXT;

CREATE TABLE users (
  email TEXT PRIMARY KEY,
  name TEXT,
  role TEXT NOT NULL CHECK (role IN ('superadmin','teacher')),
  created_at TEXT NOT NULL
);

CREATE TABLE user_classes (
  email TEXT NOT NULL,
  class_id TEXT NOT NULL,
  PRIMARY KEY (email, class_id)
);
CREATE INDEX user_classes_class ON user_classes (class_id);
