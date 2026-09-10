-- deployment-mode: rolling
-- No pending cards or historical answers are rewritten. Compatibility applies
-- only to an explicit Save/Don't save answer admitted by the canonical human
-- path, with all existing immutable-receipt, tenant, turn and revision fences.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

DO $patch$
DECLARE
  definition text := pg_get_functiondef('skill_apply_lifecycle(uuid,uuid,jsonb,jsonb)'::regprocedure);
  anchor text;
  replacement text;
BEGIN
  -- The old generic choice serializer forced Other on. It is not consent:
  -- retain a typed boolean shape, and independently forbid Other in the answer.
  anchor := $old$AND coalesce(h.questions->0->'allowOther','false'::jsonb)='false'::jsonb$old$;
  replacement := $new$AND coalesce(h.questions->0->'allowOther','false'::jsonb) IN ('false'::jsonb,'true'::jsonb)
        AND (answer->'other' IS NULL OR answer->'other'='null'::jsonb OR answer->'other'='""'::jsonb)$new$;
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor) <> 1 THEN
    RAISE EXCEPTION '0458 Skill Other compatibility anchor mismatch';
  END IF;
  definition := replace(definition,anchor,replacement);

  -- Null optional descriptions are the same absent presentation value. Keep
  -- exact option count/order/ids/labels and reject every non-null extra field.
  anchor := $old$AND h.questions->0->'options'='[{"id":"save","label":"Save"},{"id":"skip","label":"Don''t save"}]'::jsonb$old$;
  replacement := $new$AND jsonb_array_length(h.questions->0->'options')=2
        AND ((h.questions->0->'options'->0) - 'description')='{"id":"save","label":"Save"}'::jsonb
        AND ((h.questions->0->'options'->1) - 'description')='{"id":"skip","label":"Don''t save"}'::jsonb
        AND coalesce(h.questions->0->'options'->0->'description','null'::jsonb)='null'::jsonb
        AND coalesce(h.questions->0->'options'->1->'description','null'::jsonb)='null'::jsonb$new$;
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor) <> 1 THEN
    RAISE EXCEPTION '0458 Skill option compatibility anchor mismatch';
  END IF;
  EXECUTE replace(definition,anchor,replacement);
END $patch$;