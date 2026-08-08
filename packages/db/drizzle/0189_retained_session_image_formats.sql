-- deployment-mode: rolling
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "retained_screenshot_artifacts"
  ADD CONSTRAINT "retained_screenshot_artifacts_media_type_v2_chk"
  CHECK ("media_type" IN ('image/png', 'image/jpeg', 'image/webp')) NOT VALID;

ALTER TABLE "retained_screenshot_artifacts"
  VALIDATE CONSTRAINT "retained_screenshot_artifacts_media_type_v2_chk";

ALTER TABLE "retained_screenshot_artifacts"
  DROP CONSTRAINT "retained_screenshot_artifacts_media_type_chk";
