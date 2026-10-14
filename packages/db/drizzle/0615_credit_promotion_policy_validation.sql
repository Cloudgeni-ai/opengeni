-- deployment-mode: rolling
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

-- Keep owner SQL updates readable by CreditPromotionPolicy. Replacing the
-- function preserves its owner-only ACL and the immutable revision history.
CREATE OR REPLACE FUNCTION set_credit_promotion_policy(p_policy jsonb, p_operator text, p_reason text)
RETURNS bigint LANGUAGE plpgsql SET search_path = pg_catalog AS $body$
DECLARE
  -- ECMAScript String.trim whitespace; PostgreSQL btrim defaults to ASCII space.
  trim_chars CONSTANT text := U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
  model_list jsonb;
  model_id text;
  offer_id text;
  offer jsonb;
  offer_label text;
  written_revision bigint;
BEGIN
  IF p_policy IS NULL OR jsonb_typeof(p_policy) <> 'object'
    OR NOT p_policy ? 'defaultModelIds'
    OR p_policy - ARRAY['defaultModelIds', 'signupModelIds', 'offers'] <> '{}'::jsonb
    OR (p_policy ? 'offers' AND jsonb_typeof(p_policy->'offers') <> 'object') THEN
    RAISE EXCEPTION 'Policy requires defaultModelIds and optional signupModelIds/offers' USING ERRCODE = '22023';
  END IF;
  FOR offer_id, offer IN SELECT key, value FROM jsonb_each(coalesce(p_policy->'offers', '{}'::jsonb)) LOOP
    IF offer_id = '' OR jsonb_typeof(offer) <> 'object'
      OR offer - ARRAY['label', 'eligibleModelIds'] <> '{}'::jsonb
      OR jsonb_typeof(offer->'label') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'Invalid credit offer' USING ERRCODE = '22023';
    END IF;
    offer_label := btrim(offer->>'label', trim_chars);
    -- JavaScript string limits count UTF-16 units: supplementary characters use two.
    IF length(regexp_replace(offer_label, U&'[\+010000-\+10FFFF]', 'xx', 'g')) NOT BETWEEN 1 AND 120 THEN
      RAISE EXCEPTION 'Invalid credit offer label' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  FOR model_list IN
    SELECT p_policy->'defaultModelIds'
    UNION ALL SELECT p_policy->'signupModelIds' WHERE p_policy ? 'signupModelIds'
    UNION ALL SELECT value->'eligibleModelIds'
      FROM jsonb_each(coalesce(p_policy->'offers', '{}'::jsonb)) WHERE value ? 'eligibleModelIds'
  LOOP
    IF jsonb_typeof(model_list) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Model list must be an array' USING ERRCODE = '22023';
    END IF;
    IF jsonb_array_length(model_list) NOT BETWEEN 1 AND 40 OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(model_list) id WHERE jsonb_typeof(id) <> 'string'
    ) THEN
      RAISE EXCEPTION 'Model list requires 1-40 canonical model IDs' USING ERRCODE = '22023';
    END IF;
    FOR model_id IN SELECT jsonb_array_elements_text(model_list) LOOP
      IF model_id <> btrim(model_id, trim_chars)
        OR length(regexp_replace(model_id, U&'[\+010000-\+10FFFF]', 'xx', 'g')) NOT BETWEEN 1 AND 200 THEN
        RAISE EXCEPTION 'Model list requires 1-40 canonical model IDs' USING ERRCODE = '22023';
      END IF;
    END LOOP;
  END LOOP;
  -- Serializes revision order across simultaneous operator updates.
  PERFORM pg_advisory_xact_lock(hashtextextended('credit-promotion-policy', 0));
  INSERT INTO opengeni_private.credit_promotion_policy_revisions (policy, operator, reason)
    VALUES (p_policy, p_operator, p_reason) RETURNING revision INTO written_revision;
  RETURN written_revision;
END $body$;
