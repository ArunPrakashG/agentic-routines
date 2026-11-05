-- A published routine, latest version only. Steps are checked on the way in and stored as sent.
CREATE TABLE routines (
  id          uuid PRIMARY KEY,
  owner_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  site        text NOT NULL,
  description text NOT NULL,
  version     integer NOT NULL,
  body        text NOT NULL,
  meta        jsonb NOT NULL,
  steps       jsonb NOT NULL,
  installs    integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, name)
);
CREATE INDEX routines_site ON routines (site);
CREATE INDEX routines_popular ON routines (installs DESC, updated_at DESC);
