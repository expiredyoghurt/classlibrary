CREATE TABLE classes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kiosk_token TEXT NOT NULL UNIQUE,
  loan_days INTEGER NOT NULL DEFAULT 14,
  max_loans INTEGER NOT NULL DEFAULT 3,
  archived_at TEXT
);

CREATE TABLE class_pins (
  class_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('librarian','override')),
  pin_hash TEXT NOT NULL,
  PRIMARY KEY (class_id, kind)
);

CREATE TABLE pupils (
  id TEXT PRIMARY KEY,
  class_id TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_initial TEXT NOT NULL,
  full_surname TEXT,
  emoji TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (class_id, first_name, last_initial)
);
CREATE INDEX pupils_class ON pupils (class_id, active);

CREATE TABLE books (
  isbn13 TEXT PRIMARY KEY,
  title TEXT,
  authors TEXT,
  publisher TEXT,
  year INTEGER,
  description TEXT,
  cover_key TEXT,
  cover_url TEXT,
  source TEXT,
  fetched_at TEXT
);

CREATE TABLE holdings (
  id TEXT PRIMARY KEY,
  class_id TEXT NOT NULL,
  isbn13 TEXT NOT NULL,
  copies INTEGER NOT NULL DEFAULT 1,
  withdrawn INTEGER NOT NULL DEFAULT 0,
  UNIQUE (class_id, isbn13)
);
CREATE INDEX holdings_class ON holdings (class_id);

CREATE TABLE loans (
  id TEXT PRIMARY KEY,
  class_id TEXT NOT NULL,
  pupil_id TEXT NOT NULL,
  isbn13 TEXT NOT NULL,
  borrowed_at TEXT NOT NULL,
  due_at TEXT NOT NULL,
  returned_at TEXT,
  lost_at TEXT,
  found_at TEXT,
  note TEXT,
  source TEXT
);
CREATE INDEX loans_pupil_open ON loans (class_id, pupil_id) WHERE returned_at IS NULL;
CREATE INDEX loans_title ON loans (class_id, isbn13);

CREATE TABLE responses (
  loan_id TEXT PRIMARY KEY,
  stars INTEGER CHECK (stars BETWEEN 1 AND 5),
  emoji TEXT,
  recommend INTEGER,
  finished INTEGER,
  created_at TEXT
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  class_id TEXT,
  actor TEXT,
  action TEXT,
  detail TEXT,
  at TEXT NOT NULL
);
CREATE INDEX audit_class ON audit_log (class_id, at);
