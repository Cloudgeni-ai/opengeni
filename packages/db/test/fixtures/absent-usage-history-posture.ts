// Exact current-readiness findings for historical fixtures which deliberately
// stop before 0871/0872. Keep this independent of the production inventory:
// new or unexpected readiness findings must still fail those fixtures.
export const ABSENT_USAGE_HISTORY_POSTURE = [
  "subscription M3 precursor private routine read_subscription_usage_history(uuid, uuid, text, text, uuid[]) is missing or unsafe",
  "subscription M3 precursor private routine append_subscription_usage_reading(uuid, uuid, text, jsonb) is missing or unsafe",
  "subscription M3 precursor private routine prune_subscription_usage_history() is missing or unsafe",
  "subscription M3 precursor private routine subscription_usage_history_prune_due() is missing or unsafe",
  "subscription owner implementation capture_usage_reading() is missing or unsafe",
  "subscription owner implementation append_usage_reading(uuid, uuid, jsonb) is missing or unsafe",
  "subscription owner implementation capture_usage_call() is missing or unsafe",
];
