-- deployment-mode: rolling
-- online-safety-exception: constraint-validation: the checks cover only the two columns this statement adds, so every existing row holds null or the constant empty array and passes, and feedback_submissions is a small table of hand-written comments
-- Feedback may carry the app/device context it was sent from and screenshot
-- metadata; the image bytes live in object storage. Both columns are additive:
-- older writers omit them (null context, no screenshots) and older readers
-- select only the columns they know.
SET LOCAL lock_timeout = '5s';

ALTER TABLE feedback_submissions
  ADD COLUMN context jsonb CHECK (context IS NULL OR jsonb_typeof(context) = 'object'),
  ADD COLUMN screenshots jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(screenshots) = 'array' AND jsonb_array_length(screenshots) <= 3);
