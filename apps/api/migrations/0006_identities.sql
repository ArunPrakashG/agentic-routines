-- A person can sign in more than one way. An identity is one way: a provider and that provider's id for them.
-- provider is google, github, microsoft or password (the subject of a password identity is the lower-case email).
-- verified says the provider vouched for the email. Only a verified email may link a new identity to an
-- existing account, and only a verified email may make an account a reviewer.
CREATE TABLE identities (
  provider   text NOT NULL CHECK (provider IN ('google', 'github', 'microsoft', 'password')),
  subject    text NOT NULL,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email      text NOT NULL,
  verified   boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, subject)
);
CREATE INDEX identities_user ON identities (user_id);
CREATE INDEX identities_email ON identities (lower(email)) WHERE verified;

INSERT INTO identities (provider, subject, user_id, email, verified)
  SELECT 'google', google_sub, id, email, true FROM users;

ALTER TABLE users ALTER COLUMN google_sub DROP NOT NULL;
ALTER TABLE users ADD COLUMN email_verified boolean NOT NULL DEFAULT true;

-- A block on an account now names an identity (provider:subject) and covers every identity the account has.
UPDATE blocks SET value = 'google:' || value WHERE kind = 'account';

CREATE TABLE passwords (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  hash       text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The code mailed to prove control of an address. One per address, kept as an HMAC, tried at most five times.
CREATE TABLE email_codes (
  email      text PRIMARY KEY,
  code_hash  bytea NOT NULL,
  attempts   integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL
);
