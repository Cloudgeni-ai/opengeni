-- deployment-mode: rolling
ALTER TABLE "sessions"
ADD COLUMN "skills" jsonb DEFAULT '[]'::jsonb NOT NULL;
