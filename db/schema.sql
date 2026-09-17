-- Mogbattle schema (PostgreSQL 14+)
-- Applied automatically by docker-compose on first boot; or run manually:
--   psql $DATABASE_URL -f db/schema.sql

CREATE TABLE IF NOT EXISTS players (
  id               TEXT PRIMARY KEY,
  handle           TEXT NOT NULL,
  region           TEXT NOT NULL DEFAULT 'global',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  psl              NUMERIC(4,2),
  psl_confidence   NUMERIC(4,3),
  scan_version     TEXT,
  elo              INTEGER NOT NULL DEFAULT 1000,
  peak_elo         INTEGER NOT NULL DEFAULT 1000,
  wins             INTEGER NOT NULL DEFAULT 0,
  losses           INTEGER NOT NULL DEFAULT 0,
  streak           INTEGER NOT NULL DEFAULT 0,
  best_streak      INTEGER NOT NULL DEFAULT 0,
  casual_wins      INTEGER NOT NULL DEFAULT 0,
  casual_losses    INTEGER NOT NULL DEFAULT 0,
  reports_received INTEGER NOT NULL DEFAULT 0,
  flagged          BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  player_id  TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip         TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_player ON sessions(player_id);

CREATE TABLE IF NOT EXISTS scans (
  id             TEXT PRIMARY KEY,
  player_id      TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  version        TEXT NOT NULL,
  psl            NUMERIC(4,2) NOT NULL,
  confidence     NUMERIC(4,3) NOT NULL,
  quality        JSONB NOT NULL,
  components     JSONB NOT NULL,
  digest         TEXT NOT NULL,
  challenge_log  JSONB NOT NULL,
  ip             TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_scans_player ON scans(player_id);
CREATE INDEX IF NOT EXISTS idx_scans_digest ON scans(digest);

CREATE TABLE IF NOT EXISTS matches (
  id          TEXT PRIMARY KEY,
  mode        TEXT NOT NULL,              -- ranked | casual | duo | friend
  status      TEXT NOT NULL DEFAULT 'live', -- live | done | aborted
  winner_side INTEGER,
  suspicious  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS match_players (
  match_id   TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_id  TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  side       INTEGER NOT NULL,
  score      NUMERIC(4,2),
  elo_before INTEGER,
  elo_after  INTEGER,
  result     TEXT NOT NULL DEFAULT 'pending', -- pending | win | loss | abort
  suspicious BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (match_id, player_id)
);
CREATE INDEX IF NOT EXISTS idx_mp_player ON match_players(player_id);

CREATE TABLE IF NOT EXISTS ratings_history (
  id        BIGSERIAL PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  elo       INTEGER NOT NULL,
  delta     INTEGER NOT NULL,
  match_id  TEXT,
  at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ratings_player ON ratings_history(player_id, at DESC);

CREATE TABLE IF NOT EXISTS reports (
  id          BIGSERIAL PRIMARY KEY,
  reporter_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  target_id   TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  match_id    TEXT,
  reason      TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS blocks (
  player_id  TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, blocked_id)
);
