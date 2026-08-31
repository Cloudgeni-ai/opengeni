-- deployment-mode: rolling
-- Native Connected Machine workspace roots made tilde paths invalid. Repair
-- only legacy sessions whose active machine has reported an exact root; leave
-- ambiguous/offline legacy rows untouched rather than guessing a user home.

UPDATE "sessions" AS session
SET "working_dir" =
  rtrim(enrollment."workspace_root", '/') || '/' || substring(session."working_dir" FROM 3)
FROM "sandboxes" AS sandbox
JOIN "enrollments" AS enrollment ON enrollment."id" = sandbox."enrollment_id"
WHERE session."active_sandbox_id" = sandbox."id"
  AND session."working_dir" LIKE '~/%'
  AND enrollment."workspace_root" IS NOT NULL
  AND enrollment."workspace_root" <> '';
