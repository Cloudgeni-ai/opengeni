-- deployment-mode: rolling
-- App-shots: a screenshot of another app's window, sent from a desktop app,
-- carries the window it shows (app, title, capture time) and the text the
-- window exposed through accessibility. The capture is written once with the
-- file's upload and never changed, so the model's view of the message it was
-- sent with stays identical from turn to turn.
--
-- Rolling: the column is nullable and has no default, so older binaries keep
-- inserting and reading files unchanged, and no existing row is rewritten.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE files ADD COLUMN app_shot jsonb;
