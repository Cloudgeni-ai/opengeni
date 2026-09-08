---
"@opengeni/api-router": patch
---

Keep Slack delivery open across empty-result waits and pacing yields instead of announcing premature task completion and losing the later result.

Notify Slack requesters when billing or usage limits stop execution instead of silently waiting for a result that requires an owner to resolve the limit.
