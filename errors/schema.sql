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

-- 판 수·인원·걸린 시간 — 날짜·게임·이름으로 묶어 더하기만 한다. 한 판에 한 줄씩 쌓지 않는다.
CREATE TABLE IF NOT EXISTS evs (
  day     TEXT    NOT NULL,
  app     TEXT    NOT NULL,
  name    TEXT    NOT NULL,
  n       INTEGER NOT NULL DEFAULT 0,
  secs    INTEGER NOT NULL DEFAULT 0,
  players INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, app, name)
);
CREATE INDEX IF NOT EXISTS evs_app ON evs (app, day DESC);

-- 지금 누가 있나 — 탭 하나가 한 줄. 화면이 보이는 동안 1분에 한 번 at 을 새로 쓴다.
-- 오래된 줄은 읽을 때와 가끔 쓸 때 지운다. 개인을 가려낼 정보는 없다(sid 는 탭마다 새로 만든 무작위 값).
CREATE TABLE IF NOT EXISTS live (
  sid TEXT    PRIMARY KEY,
  app TEXT    NOT NULL,
  st  TEXT    NOT NULL,     -- play: 판 중 · look: 화면만 보는 중
  at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS live_at ON live (at);
