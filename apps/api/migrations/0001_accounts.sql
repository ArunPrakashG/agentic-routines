CREATE TABLE users (
  id          uuid PRIMARY KEY,
  google_sub  text NOT NULL UNIQUE,
  email       text NOT NULL,
  name        text NOT NULL,
  picture     text,
  handle      text UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- One per signed-in install. A refresh token works once and is stored as a SHA-256 hash.
CREATE TABLE sessions (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  install_id    text NOT NULL,
  refresh_hash  bytea NOT NULL UNIQUE,
  previous_hash bytea,
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_install ON sessions (user_id, install_id);
CREATE INDEX sessions_previous ON sessions (previous_hash) WHERE previous_hash IS NOT NULL;
CREATE INDEX sessions_expires ON sessions (expires_at);
