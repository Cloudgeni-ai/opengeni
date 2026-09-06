-- deployment-mode: rolling
-- A finite provider lifetime is a hard destruction boundary. Once the normal
-- lead-time rotation request is durable, persistent Browser/Computer placement
-- must yield while enough time remains to quiesce writers and capture the exact
-- workspace generation. Waiting until the provider deadline keeps the lease
-- holder alive until the same instant the provider may destroy the box.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $sandbox_deadline_rotation_preemption$
DECLARE
  definition text;
  patched text;
  eligibility_anchor constant text :=
    E'          AND lease.provider_deadline_at <= pg_catalog.now()';
  eligibility_replacement constant text :=
    E'          -- 0397 deadline rotation preemption: an automatic finite-lifetime\n'
    || E'          -- rotation yields persistent controllers at the lead boundary;\n'
    || E'          -- unrelated operator rotations retain the hard-deadline fallback.\n'
    || E'          AND (\n'
    || E'            lease.rotation_reason = ''provider_deadline''\n'
    || E'            OR lease.provider_deadline_at <= pg_catalog.now()\n'
    || E'          )';
  message_anchor constant text :=
    E'          error_message = ''Interaction controller reached its sandbox provider deadline'',';
  message_replacement constant text :=
    E'          error_message = ''Interaction controller yielded for sandbox provider rotation'',';
  occurrences integer;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(
    'opengeni_private.reap_stale_interaction_transitions(bigint)'::regprocedure
  ) INTO definition;

  IF definition IS NULL
    OR pg_catalog.strpos(
      definition,
      '0391 provider-deadline interaction follow-up'
    ) = 0
    OR pg_catalog.strpos(
      definition,
      'interaction_holder.kind = ''interaction'''
    ) = 0
    OR pg_catalog.strpos(definition, 'provider_deadline_rotation') = 0
  THEN
    RAISE EXCEPTION '0397 interaction rotation prerequisite definition drift'
      USING ERRCODE = '55000';
  END IF;

  IF pg_catalog.strpos(definition, '0397 deadline rotation preemption') > 0 THEN
    IF pg_catalog.strpos(
      definition,
      'lease.rotation_reason = ''provider_deadline'''
    ) = 0
      OR pg_catalog.strpos(
        definition,
        'Interaction controller yielded for sandbox provider rotation'
      ) = 0
    THEN
      RAISE EXCEPTION '0397 interaction rotation replay definition drift'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    patched := definition;

    occurrences := (
      pg_catalog.length(patched)
        - pg_catalog.length(pg_catalog.replace(patched, eligibility_anchor, ''))
    ) / pg_catalog.length(eligibility_anchor);
    IF occurrences <> 1 THEN
      RAISE EXCEPTION '0397 interaction rotation eligibility anchor drift'
        USING ERRCODE = '55000';
    END IF;
    patched := pg_catalog.replace(
      patched,
      eligibility_anchor,
      eligibility_replacement
    );

    occurrences := (
      pg_catalog.length(patched)
        - pg_catalog.length(pg_catalog.replace(patched, message_anchor, ''))
    ) / pg_catalog.length(message_anchor);
    IF occurrences <> 1 THEN
      RAISE EXCEPTION '0397 interaction rotation message anchor drift'
        USING ERRCODE = '55000';
    END IF;
    patched := pg_catalog.replace(
      patched,
      message_anchor,
      message_replacement
    );

    IF pg_catalog.strpos(patched, '0397 deadline rotation preemption') = 0
      OR pg_catalog.strpos(
        patched,
        'lease.rotation_reason = ''provider_deadline'''
      ) = 0
      OR pg_catalog.strpos(
        patched,
        'OR lease.provider_deadline_at <= pg_catalog.now()'
      ) = 0
    THEN
      RAISE EXCEPTION '0397 interaction rotation patch failed'
        USING ERRCODE = '55000';
    END IF;

    EXECUTE patched;
  END IF;
END
$sandbox_deadline_rotation_preemption$;

RESET statement_timeout;
RESET lock_timeout;
