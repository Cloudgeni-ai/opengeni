-- deployment-mode: rolling
-- tracking-64: workspace-control rows are compact invalidations, not evidence blobs.
-- Preserve exact source byte counts while bounding the two free-form fields so
-- old binaries and direct writers cannot create a durable replay poison row.

SET lock_timeout = '5s';
SET statement_timeout = '10min';

ALTER TABLE workspace_control_events
  ADD COLUMN reason_original_bytes integer,
  ADD COLUMN actor_original_bytes integer;

CREATE OR REPLACE FUNCTION opengeni_private.truncate_workspace_control_text(
  source_text text,
  max_bytes integer
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $function$
DECLARE
  marker constant text := '…[truncated]';
  prefix_budget integer := greatest(0, max_bytes - octet_length(marker));
  candidate text;
  excess integer;
BEGIN
  IF octet_length(source_text) <= max_bytes THEN
    RETURN source_text;
  END IF;

  -- left() is character-safe. Starting at at most prefix_budget characters
  -- caps allocation even for a multi-megabyte legacy value; each pass removes
  -- enough characters for the worst-case four-byte UTF-8 encoding.
  candidate := left(source_text, prefix_budget);
  WHILE octet_length(candidate) > prefix_budget LOOP
    excess := octet_length(candidate) - prefix_budget;
    candidate := left(candidate, greatest(0, char_length(candidate) - ceil(excess / 4.0)::integer));
  END LOOP;
  RETURN candidate || marker;
END;
$function$;

CREATE OR REPLACE FUNCTION opengeni_private.bound_workspace_control_event()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  source_bytes integer;
BEGIN
  IF NEW.reason IS NULL THEN
    NEW.reason_original_bytes := NULL;
  ELSE
    source_bytes := octet_length(NEW.reason);
    IF TG_OP = 'INSERT' THEN
      NEW.reason_original_bytes := greatest(source_bytes, coalesce(NEW.reason_original_bytes, 0));
    ELSIF NEW.reason IS DISTINCT FROM OLD.reason THEN
      -- An update from an old binary carries the old metadata column even
      -- though it knows only `reason`. A genuinely changed raw value starts a
      -- new byte fact instead of inheriting the previous value's larger count.
      NEW.reason_original_bytes := source_bytes;
    ELSE
      NEW.reason_original_bytes := greatest(
        source_bytes,
        coalesce(NEW.reason_original_bytes, OLD.reason_original_bytes, 0)
      );
    END IF;
    NEW.reason := opengeni_private.truncate_workspace_control_text(NEW.reason, 8192);
  END IF;

  source_bytes := octet_length(NEW.actor);
  IF TG_OP = 'INSERT' THEN
    NEW.actor_original_bytes := greatest(source_bytes, coalesce(NEW.actor_original_bytes, 0));
  ELSIF NEW.actor IS DISTINCT FROM OLD.actor THEN
    NEW.actor_original_bytes := source_bytes;
  ELSE
    NEW.actor_original_bytes := greatest(
      source_bytes,
      coalesce(NEW.actor_original_bytes, OLD.actor_original_bytes, 0)
    );
  END IF;
  NEW.actor := opengeni_private.truncate_workspace_control_text(NEW.actor, 1024);
  RETURN NEW;
END;
$function$;

CREATE TRIGGER workspace_control_events_bound_fields
BEFORE INSERT OR UPDATE OF reason, actor, reason_original_bytes, actor_original_bytes
ON workspace_control_events
FOR EACH ROW EXECUTE FUNCTION opengeni_private.bound_workspace_control_event();

-- Rewrite only historical rows that violate the new durable caps. Already
-- bounded rows are safe to serve as-is and retain null metadata as the explicit
-- rolling-upgrade legacy shape; avoiding a blanket UPDATE keeps installation
-- work proportional to poison rows instead of table cardinality. The original
-- counts are supplied in the same statement so truncation never erases truth.
UPDATE workspace_control_events
SET
  reason_original_bytes = CASE WHEN reason IS NULL THEN NULL ELSE octet_length(reason) END,
  actor_original_bytes = octet_length(actor),
  reason = reason,
  actor = actor
WHERE octet_length(reason) > 8192
   OR octet_length(actor) > 1024;

ALTER TABLE workspace_control_events
  ADD CONSTRAINT workspace_control_events_reason_bytes_check
    CHECK (reason IS NULL OR octet_length(reason) <= 8192) NOT VALID,
  ADD CONSTRAINT workspace_control_events_actor_bytes_check
    CHECK (octet_length(actor) <= 1024) NOT VALID,
  ADD CONSTRAINT workspace_control_events_original_bytes_check
    CHECK (
      (reason IS NULL AND reason_original_bytes IS NULL)
      OR (
        reason IS NOT NULL
        AND (
          reason_original_bytes IS NULL
          OR reason_original_bytes >= octet_length(reason)
        )
      )
    ) NOT VALID,
  ADD CONSTRAINT workspace_control_events_actor_original_bytes_check
    CHECK (
      actor_original_bytes IS NULL
      OR actor_original_bytes >= octet_length(actor)
    ) NOT VALID;

ALTER TABLE workspace_control_events
  VALIDATE CONSTRAINT workspace_control_events_reason_bytes_check,
  VALIDATE CONSTRAINT workspace_control_events_actor_bytes_check,
  VALIDATE CONSTRAINT workspace_control_events_original_bytes_check,
  VALIDATE CONSTRAINT workspace_control_events_actor_original_bytes_check;
