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

CREATE TABLE IF NOT EXISTS ask_groups (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  body              TEXT NOT NULL DEFAULT '',
  producer_kind     TEXT NOT NULL CHECK (producer_kind IN ('human','agent')),
  producer_agent    TEXT,
  producer_project  TEXT,
  producer_cwd      TEXT,
  producer_session  TEXT,
  producer_pid      INTEGER,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ask_group_members (
  group_id     TEXT NOT NULL REFERENCES ask_groups(id) ON DELETE CASCADE,
  ticket_id    TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  member_role  TEXT NOT NULL DEFAULT 'opinion' CHECK (member_role IN ('opinion')),
  position     INTEGER NOT NULL CHECK (position >= 0),
  created_at   TEXT NOT NULL,
  PRIMARY KEY (group_id, ticket_id),
  UNIQUE (ticket_id),
  UNIQUE (group_id, position)
);

CREATE INDEX IF NOT EXISTS idx_ask_group_members_group
  ON ask_group_members(group_id, position, ticket_id);

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
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_replies_ticket ON replies(ticket_id, created_at);
CREATE INDEX IF NOT EXISTS idx_replies_final  ON replies(ticket_id) WHERE is_final = 1;

CREATE TABLE IF NOT EXISTS thread_messages (
  id                    TEXT PRIMARY KEY,
  root_kind             TEXT NOT NULL CHECK (root_kind IN ('ticket','ask_group')),
  root_id               TEXT NOT NULL,
  seq                   INTEGER NOT NULL CHECK (seq > 0),
  kind                  TEXT NOT NULL CHECK (kind IN ('opened','claimed','progress','question','answer','note','result','canceled','released','system')),
  body                  TEXT NOT NULL DEFAULT '',
  actor_kind            TEXT NOT NULL CHECK (actor_kind IN ('human','agent','system')),
  actor_role            TEXT NOT NULL CHECK (actor_role IN ('producer','claimer','other','system')),
  actor_agent           TEXT,
  actor_project         TEXT,
  actor_cwd             TEXT,
  actor_session         TEXT,
  actor_pid             INTEGER,
  ticket_id             TEXT REFERENCES tickets(id) ON DELETE CASCADE,
  caused_by_message_id  TEXT REFERENCES thread_messages(id) ON DELETE SET NULL,
  correlation_id        TEXT,
  created_at            TEXT NOT NULL,
  UNIQUE(root_kind, root_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_thread_messages_root_seq
  ON thread_messages(root_kind, root_id, seq);

CREATE INDEX IF NOT EXISTS idx_thread_messages_ticket_seq
  ON thread_messages(ticket_id, seq)
  WHERE ticket_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS docs (
  id                 TEXT PRIMARY KEY,
  owner_kind         TEXT NOT NULL CHECK (owner_kind IN ('ask_group','ticket','reply','message')),
  ask_group_id       TEXT REFERENCES ask_groups(id) ON DELETE CASCADE,
  ticket_id          TEXT REFERENCES tickets(id) ON DELETE CASCADE,
  reply_id           TEXT REFERENCES replies(id) ON DELETE CASCADE,
  thread_message_id  TEXT REFERENCES thread_messages(id) ON DELETE CASCADE,
  position           INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  title              TEXT NOT NULL,
  content_type       TEXT NOT NULL DEFAULT 'text/markdown; charset=utf-8',
  content            TEXT NOT NULL DEFAULT '',
  size_bytes         INTEGER NOT NULL CHECK (size_bytes >= 0),
  created_at         TEXT NOT NULL,
  CHECK (
       (owner_kind = 'ask_group' AND ask_group_id IS NOT NULL AND ticket_id IS NULL AND reply_id IS NULL AND thread_message_id IS NULL)
    OR (owner_kind = 'ticket'    AND ask_group_id IS NULL AND ticket_id IS NOT NULL AND reply_id IS NULL AND thread_message_id IS NULL)
    OR (owner_kind = 'reply'     AND ask_group_id IS NULL AND ticket_id IS NULL AND reply_id IS NOT NULL AND thread_message_id IS NULL)
    OR (owner_kind = 'message'   AND ask_group_id IS NULL AND ticket_id IS NULL AND reply_id IS NULL AND thread_message_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_docs_ask_group
  ON docs(ask_group_id, position, id)
  WHERE owner_kind = 'ask_group';

CREATE INDEX IF NOT EXISTS idx_docs_ticket
  ON docs(ticket_id, position, id)
  WHERE owner_kind = 'ticket';

CREATE INDEX IF NOT EXISTS idx_docs_reply
  ON docs(reply_id, position, id)
  WHERE owner_kind = 'reply';

CREATE INDEX IF NOT EXISTS idx_docs_message
  ON docs(thread_message_id, position, id)
  WHERE owner_kind = 'message';
