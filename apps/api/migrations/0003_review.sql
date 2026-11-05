-- Nothing reaches the directory without a person approving it. A publish makes a submission;
-- approving it is what puts the routine in `routines`, which only ever holds approved work.
CREATE TABLE submissions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  site        text NOT NULL,
  description text NOT NULL,
  version     integer NOT NULL,
  body        text NOT NULL,
  meta        jsonb NOT NULL,
  steps       jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  guideline   text,
  note        text,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  decided_at  timestamptz,
  decided_by  text
);
-- One waiting submission per routine: a newer one replaces the older.
CREATE UNIQUE INDEX submissions_one_pending ON submissions (owner_id, name) WHERE status = 'pending';
CREATE INDEX submissions_queue ON submissions (status, submitted_at);
CREATE INDEX submissions_owner ON submissions (owner_id, submitted_at DESC);

-- A live routine can be switched off without deleting it.
ALTER TABLE routines
  ADD COLUMN disabled boolean NOT NULL DEFAULT false,
  ADD COLUMN disabled_reason text,
  ADD COLUMN approved_at timestamptz NOT NULL DEFAULT now();

-- kind is user (a handle), repo (a Git address) or routine (owner/name).
CREATE TABLE blocks (
  kind       text NOT NULL CHECK (kind IN ('user', 'repo', 'routine')),
  value      text NOT NULL,
  reason     text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  PRIMARY KEY (kind, value)
);

-- What an admin did, for the admin to look back on.
CREATE TABLE audit (
  id     bigserial PRIMARY KEY,
  admin  text NOT NULL,
  action text NOT NULL,
  target text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_at ON audit (at DESC);
