---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/db": minor
"@opengeni/core": minor
"@opengeni/config": minor
---

Add optional per-task usage limits. A root session can carry a limit in USD micros of API-equivalent model usage (the pre-margin provider list-price estimate) shared by all of its child agents. New model requests are refused once recorded usage reaches it; requests already running finish, so usage can go above it. Set it with `usageLimitMicros` on create or `setSessionUsageLimit`, read it with `getSessionUsageLimit`; both verify the server's echo. A reached limit is a typed `session_usage_limit_reached` refusal and a `segmentLimit: "session_usage_limit"` stop, never a credits error. New producers are gated by `OPENGENI_SESSION_USAGE_LIMITS_ENABLED` (default off); persisted limits are always enforced.
