-- 같은 오류(앱·메시지·파일·줄)는 한 줄에 모아 센다. 스택은 마지막 것만 남긴다.
CREATE TABLE IF NOT EXISTS errs (
  id       TEXT PRIMARY KEY,
  app      TEXT NOT NULL,
  msg      TEXT NOT NULL,
  src      TEXT,
  line     INTEGER,
  col      INTEGER,
  stack    TEXT,
  ua       TEXT,
  page     TEXT,
  n        INTEGER NOT NULL DEFAULT 1,
  first_at INTEGER NOT NULL,
  last_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS errs_last ON errs (last_at DESC);
CREATE INDEX IF NOT EXISTS errs_app  ON errs (app, last_at DESC);
