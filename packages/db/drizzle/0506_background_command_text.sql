-- deployment-mode: rolling
-- Existing rows retain their preview; new registrations preserve original text.
ALTER TABLE session_background_commands ADD COLUMN command_text text;
