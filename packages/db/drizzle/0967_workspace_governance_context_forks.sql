-- deployment-mode: rolling
-- Workspace governance now reaches the model as a durable developer message
-- placed before the turn that first sees a new value, at a fractional history
-- position, exactly like the skill catalog (0487). Message forks fail closed on
-- unknown fractional rows, so permit these marked governance messages too.
-- Every other check is unchanged.
--
-- Rolling: only the fork routine bodies change. The previous release never
-- writes governance rows, so it is unaffected by the wider predicate.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $governance_forks$
DECLARE
  catalog_prefix constant text :=
    $q$starts_with(history.item ->> 'content', E'<opengeni_skill_catalog>\n')$q$;
  catalog_suffix constant text :=
    $q$right(history.item ->> 'content', length(E'\n</opengeni_skill_catalog>')) = E'\n</opengeni_skill_catalog>'$q$;
  governance_marker constant text := $q$E'<opengeni_workspace_governance>\n'$q$;
  replacement constant text :=
    $q$((starts_with(history.item ->> 'content', E'<opengeni_skill_catalog>\n')$q$ ||
    $q$ AND right(history.item ->> 'content', length(E'\n</opengeni_skill_catalog>')) = E'\n</opengeni_skill_catalog>')$q$ ||
    $q$ OR (starts_with(history.item ->> 'content', E'<opengeni_workspace_governance>\n')$q$ ||
    $q$ AND right(history.item ->> 'content', length(E'\n</opengeni_workspace_governance>')) = E'\n</opengeni_workspace_governance>'))$q$;
  target regprocedure;
  definition text;
  prefix_count integer;
  suffix_count integer;
  patched_any boolean := false;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'fork_session_content(uuid,uuid,uuid,text,uuid,text,boolean,text,text,integer)'::regprocedure,
    'fork_session_content(uuid,uuid,uuid,text,uuid,text,boolean,text,text,integer,uuid)'::regprocedure
  ] LOOP
    definition := pg_get_functiondef(target);
    IF strpos(definition, governance_marker) > 0 THEN
      patched_any := true;
      CONTINUE;
    END IF;
    prefix_count :=
      (length(definition) - length(replace(definition, catalog_prefix, ''))) / length(catalog_prefix);
    suffix_count :=
      (length(definition) - length(replace(definition, catalog_suffix, ''))) / length(catalog_suffix);
    IF prefix_count <> suffix_count THEN
      RAISE EXCEPTION 'skill catalog fork predicate of % changed before 0967', target;
    END IF;
    CONTINUE WHEN prefix_count = 0;
    -- The suffix check moves next to its prefix, so either marker pair passes.
    definition := replace(definition, catalog_suffix, 'TRUE');
    definition := replace(definition, catalog_prefix, replacement);
    EXECUTE definition;
    IF strpos(pg_get_functiondef(target), governance_marker) = 0 THEN
      RAISE EXCEPTION 'workspace governance fork predicate was not installed for %', target;
    END IF;
    patched_any := true;
  END LOOP;
  IF NOT patched_any THEN
    RAISE EXCEPTION 'no fork routine carries the skill catalog predicate before 0967';
  END IF;
END
$governance_forks$;
