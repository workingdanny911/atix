PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS channels (
  name         TEXT PRIMARY KEY,
  description  TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  archived_at  TEXT,
  CHECK (length(name) BETWEEN 1 AND 64
         AND name NOT LIKE '%..%'
         AND name NOT LIKE '.%'
         AND name NOT LIKE '%.')
);

CREATE TABLE IF NOT EXISTS tickets (
  id                TEXT PRIMARY KEY,
  channel           TEXT NOT NULL REFERENCES channels(name) ON UPDATE CASCADE,
  status            TEXT NOT NULL CHECK (status IN ('open','claimed','done','canceled')),
  title             TEXT NOT NULL,
  body              TEXT NOT NULL DEFAULT '',
  producer_kind     TEXT NOT NULL CHECK (producer_kind IN ('human','agent')),
  producer_agent    TEXT,
  producer_project  TEXT,
  producer_cwd      TEXT,
  producer_session  TEXT,
  producer_pid      INTEGER,
  claimer_agent     TEXT,
  claimer_project   TEXT,
  claimer_cwd       TEXT,
  claimer_session   TEXT,
  claimer_pid       INTEGER,
  created_at        TEXT NOT NULL,
  claimed_at        TEXT,
  closed_at         TEXT,
  claim_token       TEXT,
  CHECK ((status = 'open'      AND claimed_at IS NULL AND claimer_agent IS NULL AND claim_token IS NULL)
      OR (status = 'claimed'   AND claimed_at IS NOT NULL AND claim_token IS NOT NULL)
      OR (status IN ('done','canceled') AND closed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_tickets_open_by_channel ON tickets(channel, created_at) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_tickets_channel_created ON tickets(channel, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_claimer ON tickets(claimer_agent, status) WHERE status = 'claimed';
CREATE INDEX IF NOT EXISTS idx_tickets_claimed_at ON tickets(claimed_at) WHERE status = 'claimed';

CREATE TABLE IF NOT EXISTS replies (
  id              TEXT PRIMARY KEY,
  ticket_id       TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_kind     TEXT NOT NULL CHECK (author_kind IN ('human','agent')),
  author_role     TEXT NOT NULL CHECK (author_role IN ('claimer','producer','other')),
  author_agent    TEXT,
  author_project  TEXT,
  author_cwd      TEXT,
  author_session  TEXT,
  author_pid      INTEGER,
  is_final        INTEGER NOT NULL DEFAULT 0,
  body            TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  CHECK (length(body) > 0)
);

CREATE INDEX IF NOT EXISTS idx_replies_ticket ON replies(ticket_id, created_at);
CREATE INDEX IF NOT EXISTS idx_replies_final  ON replies(ticket_id) WHERE is_final = 1;
