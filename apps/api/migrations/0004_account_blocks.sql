-- Blocking a publisher also blocks the Google account behind the handle, so deleting the account and
-- signing up again under another handle does not lift it. The value is the account's Google subject.
ALTER TABLE blocks DROP CONSTRAINT blocks_kind_check;
ALTER TABLE blocks ADD CONSTRAINT blocks_kind_check CHECK (kind IN ('user', 'repo', 'routine', 'account'));
