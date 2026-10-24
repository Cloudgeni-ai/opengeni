/** 0929 redefines the exhausted-task predicate 0761 creates, patches the
 * scheduled occurrence validator 0275 installs by its anchor, and builds its
 * policies on the 0345 fence helpers; 0932, 0935, 0937, 0938, 0941, 0947 and
 * 0951 build on 0929. Historical fixtures that withhold any of those must
 * replay this tail after them. */
export const eventTriggerMigrationTail = [
  "0929_event_triggers.sql",
  "0932_mcp_event_subscriptions.sql",
  "0935_event_source_feeds.sql",
  "0937_definer_runtime_grants_deferred.sql",
  "0938_event_source_awaiting_secret.sql",
  "0941_event_ingress_routes_without_identities.sql",
  "0947_definer_runtime_grants.sql",
  "0951_repeating_event_triggers_outlive_schedule.sql",
] as const;
