-- deployment-mode: rolling
-- The two wake repair inventories run every few seconds from the control
-- worker (prod: about 5,440 calls each in 5 h, 16 ms and 15 ms mean). Their
-- cost is mostly planning. PL/pgSQL plans a parameterized statement afresh
-- (a custom plan) for its first five calls on each connection, and pooled
-- connections close after 30 s idle, so most calls planned again:
--
-- - list_pending_child_terminal_wake_repairs_v1 joins six relations. Locally
--   it plans in about 12 ms and runs in about 1 ms (54 pending child results);
--   most of the planning is the join-order search.
-- - list_quiescence_receipt_wake_repairs_v1 plans in about 2.6 ms.
--
-- Both now plan once per connection and reuse that plan
-- (plan_cache_mode = force_generic_plan, which PostgreSQL would choose itself
-- after five calls when it judges it no worse). The child-result inventory
-- also keeps its written join order (join_collapse_limit = 1): it already
-- starts from the small pending-child-result partial index and reaches every
-- other relation by key, which is the plan the planner picked; planning drops
-- to about 2.4 ms. Only plans change; the statements, owners, ACLs, SECURITY
-- DEFINER and search paths are unchanged, so results are identical. The
-- runtime posture check requires search_path=pg_catalog among the settings,
-- which stays. No table is locked.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

ALTER FUNCTION opengeni_private.list_pending_child_terminal_wake_repairs_v1(integer, uuid, uuid)
  SET plan_cache_mode = force_generic_plan;
ALTER FUNCTION opengeni_private.list_pending_child_terminal_wake_repairs_v1(integer, uuid, uuid)
  SET join_collapse_limit = 1;
ALTER FUNCTION opengeni_private.list_quiescence_receipt_wake_repairs_v1(integer, uuid, uuid)
  SET plan_cache_mode = force_generic_plan;
