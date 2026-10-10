---
---

Add two default-off experiments: `OPENGENI_EXPERIMENT_COMPACT_THRESHOLD_POLICY=cost` lowers each model's default compaction trigger to a price-derived value, and `OPENGENI_EXPERIMENT_CACHE_TTL_POLICY=warm_1h|always_1h` uses 1-hour prompt caching on first-party native Claude routes.
