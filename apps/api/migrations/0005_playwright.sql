-- A routine's steps compiled to Playwright, for reading. Never run from here: what runs is compiled on the person's machine from the steps they installed.
ALTER TABLE submissions ADD COLUMN playwright text NOT NULL DEFAULT '';
ALTER TABLE routines ADD COLUMN playwright text NOT NULL DEFAULT '';
