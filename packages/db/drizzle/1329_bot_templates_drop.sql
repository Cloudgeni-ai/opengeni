-- deployment-mode: rolling
-- online-safety-exception: explicit-lock: dropping bot_templates takes ACCESS EXCLUSIVE on workspaces (its one foreign key) and bot_templates anyway; locking workspaces first matches the order a cascading workspace delete takes them in, so the drop cannot deadlock with one.
-- contract-step: since the agents contract (migrations 1301 to 1319) no binary reads or writes bot_templates, nothing references it, and its readiness check accepts the table absent.
-- Agents legacy drop: drop the legacy bot templates table (agents replaced
-- it). Its only foreign key is to workspaces, and only workspace deletes
-- reach it. No CASCADE: its policies and indexes go with it.
SET LOCAL lock_timeout = '5s';

LOCK TABLE workspaces IN ACCESS EXCLUSIVE MODE;
LOCK TABLE bot_templates IN ACCESS EXCLUSIVE MODE;
DROP TABLE IF EXISTS bot_templates;
