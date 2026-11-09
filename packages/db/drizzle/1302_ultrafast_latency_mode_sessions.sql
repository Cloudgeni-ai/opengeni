-- deployment-mode: rolling
-- Ultrafast speed (latency mode 'ultrafast') is offered for GPT-6 Astra and
-- GPT-6.1 Sol, but the latency_mode checks still allowed only standard,
-- priority and fast, so every chat, turn and draft that chose it failed.
-- 1302-1305 widen the four checks NOT VALID (each table in its own short
-- transaction) and 1306 lets scheduled-run admission read it from session
-- metadata; 1307-1310 validate them. Widening a check never rejects a row the
-- previous release writes, so it is unaffected.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

ALTER TABLE sessions
  DROP CONSTRAINT sessions_latency_mode_check,
  ADD CONSTRAINT sessions_latency_mode_check
    CHECK (latency_mode IN ('standard', 'priority', 'fast', 'ultrafast')) NOT VALID;
