-- deployment-mode: rolling
-- Private attribution joins a bounded session inventory to the full usage
-- window. Cardinality estimates can choose millions of random index reads;
-- the same inputs and predicates are substantially cheaper with a hash join.
-- As in 0512, keep this planner setting local to the existing authority
-- function. No query, capability, policy, ACL or caller setting is changed.
ALTER FUNCTION opengeni_private.organization_usage_summary(
  uuid, timestamp with time zone, timestamp with time zone, text, uuid, boolean
) SET enable_nestloop = off;