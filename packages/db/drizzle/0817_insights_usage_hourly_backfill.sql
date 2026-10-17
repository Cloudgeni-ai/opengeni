-- deployment-mode: rolling
-- opengeni:batched-backfill batch-size=1 lock-timeout=1s statement-timeout=30s
-- Commit every hour separately. Only writers to this exact workspace/hour
-- wait for the rebuild; failed batches remain pending and safely retry.
WITH candidate AS MATERIALIZED (
  SELECT account_id,workspace_id,hour FROM opengeni_private.insights_usage_hourly_backfill
  WHERE NOT completed ORDER BY workspace_id,hour LIMIT 1
), backfilled AS (
  UPDATE opengeni_private.insights_usage_hourly_backfill b
  SET completed=opengeni_insights_internal.insights_usage_hourly_recompute(b.account_id,b.workspace_id,b.hour)
  FROM candidate c WHERE b.workspace_id=c.workspace_id AND b.hour=c.hour
  RETURNING b.workspace_id,b.hour
) SELECT * FROM backfilled;
