-- deployment-mode: rolling
-- contract-step: optional catalog metadata; existing revisions and routine ACLs
--   are unchanged. Roll out compatible readers before writing legacy price IDs.
SET lock_timeout = '5s';

CREATE OR REPLACE FUNCTION set_subscription_plan_catalog(p_catalog jsonb, p_operator text, p_reason text)
RETURNS bigint LANGUAGE plpgsql SET search_path FROM CURRENT AS $body$
DECLARE entry jsonb; legacy_price jsonb; written bigint;
BEGIN
  IF jsonb_typeof(p_catalog) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Plan catalog must be an array' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_catalog) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Plan catalog requires 1-100 plans' USING ERRCODE = '22023';
  END IF;
  FOR entry IN SELECT value FROM jsonb_array_elements(p_catalog) LOOP
    IF jsonb_typeof(entry) IS DISTINCT FROM 'object'
      OR NOT entry ?& ARRAY['key','label','stripePriceId','monthlyPriceMicros','monthlyCreditMicros','seatLimit','freeCredit']
      OR entry - ARRAY['key','label','stripePriceId','legacyStripePriceIds','monthlyPriceMicros','monthlyCreditMicros','seatLimit','freeCredit'] <> '{}'::jsonb
      OR coalesce(entry->>'key', '') !~ '^[a-z][a-z0-9_-]{0,39}$'
      OR jsonb_typeof(entry->'label') IS DISTINCT FROM 'string'
      OR length(btrim(entry->>'label')) NOT BETWEEN 1 AND 120
      OR (entry->'stripePriceId' <> 'null'::jsonb AND
        (jsonb_typeof(entry->'stripePriceId') <> 'string' OR length(btrim(entry->>'stripePriceId')) NOT BETWEEN 1 AND 200
          OR entry->>'stripePriceId' <> btrim(entry->>'stripePriceId')))
      OR jsonb_typeof(entry->'monthlyCreditMicros') IS DISTINCT FROM 'number'
      OR (entry->>'monthlyCreditMicros')::numeric NOT BETWEEN 0 AND 9007199254740991
      OR (entry->>'monthlyCreditMicros')::numeric <> trunc((entry->>'monthlyCreditMicros')::numeric)
      OR (entry->'monthlyPriceMicros' <> 'null'::jsonb AND
        (jsonb_typeof(entry->'monthlyPriceMicros') <> 'number'
          OR (entry->>'monthlyPriceMicros')::numeric NOT BETWEEN 0 AND 9007199254740991
          OR (entry->>'monthlyPriceMicros')::numeric <> trunc((entry->>'monthlyPriceMicros')::numeric)))
      OR (entry->'seatLimit' <> 'null'::jsonb AND
        (jsonb_typeof(entry->'seatLimit') <> 'number' OR (entry->>'seatLimit')::numeric NOT BETWEEN 1 AND 1000000
          OR (entry->>'seatLimit')::numeric <> trunc((entry->>'seatLimit')::numeric)))
      OR jsonb_typeof(entry->'freeCredit') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'Invalid plan catalog entry' USING ERRCODE = '22023';
    END IF;
    IF entry ? 'legacyStripePriceIds' THEN
      IF jsonb_typeof(entry->'legacyStripePriceIds') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'Legacy Stripe price IDs must be an array' USING ERRCODE = '22023';
      END IF;
      IF jsonb_array_length(entry->'legacyStripePriceIds') > 100 THEN
        RAISE EXCEPTION 'At most 100 legacy Stripe price IDs are allowed per plan' USING ERRCODE = '22023';
      END IF;
      FOR legacy_price IN SELECT value FROM jsonb_array_elements(entry->'legacyStripePriceIds') LOOP
        IF jsonb_typeof(legacy_price) IS DISTINCT FROM 'string'
          OR length(btrim(legacy_price #>> '{}')) NOT BETWEEN 1 AND 200
          OR legacy_price #>> '{}' <> btrim(legacy_price #>> '{}') THEN
          RAISE EXCEPTION 'Invalid legacy Stripe price ID' USING ERRCODE = '22023';
        END IF;
      END LOOP;
    END IF;
  END LOOP;
  IF (SELECT count(*) <> count(DISTINCT value->>'key') FROM jsonb_array_elements(p_catalog))
    OR (SELECT count(price) <> count(DISTINCT price) FROM (
      SELECT value->>'stripePriceId' AS price FROM jsonb_array_elements(p_catalog)
      UNION ALL
      SELECT legacy.value FROM jsonb_array_elements(p_catalog) plan,
        LATERAL jsonb_array_elements_text(coalesce(plan.value->'legacyStripePriceIds', '[]'::jsonb)) legacy
    ) prices) THEN
    RAISE EXCEPTION 'Plan keys and current or legacy Stripe prices must be unique' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('subscription-plan-catalog', 0));
  IF EXISTS (SELECT 1 FROM opengeni_private.subscription_plan_catalog_revisions revision,
    LATERAL jsonb_array_elements(revision.catalog) old_entry
    WHERE revision.revision = (SELECT max(revision) FROM opengeni_private.subscription_plan_catalog_revisions)
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_catalog) candidate WHERE candidate->>'key' = old_entry->>'key')) THEN
    RAISE EXCEPTION 'Existing plan keys cannot be removed from the catalog' USING ERRCODE = '22023';
  END IF;
  INSERT INTO opengeni_private.subscription_plan_catalog_revisions(catalog, operator, reason)
    VALUES (p_catalog, p_operator, p_reason) RETURNING revision INTO written;
  RETURN written;
END $body$;
