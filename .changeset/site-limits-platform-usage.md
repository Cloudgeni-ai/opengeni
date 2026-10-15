---
"@opengeni/api-router": minor
"@opengeni/contracts": minor
"@opengeni/config": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/sdk": major
"@opengeni/react": major
"@opengeni/runtime": minor
"@opengeni/worker-bundle": minor
---

Published Site limits now follow the viewer. Workspace members have no Site caps, only the flood brakes, and keep the embedded agent even when it is off for everyone else. Invited and signed-in people share one Site spend limit ($10 a month by default, or a daily limit) with an optional per-person limit; guests also meet the bot guards (20 conversations per visitor per day, 500 per Site per day, 50 turns and $1 per conversation). Workspace tools reach only members who may use connections, and outsiders never get a subscription-billed model: they use the workspace's credit-billed default or are refused. Sites also meter platform usage (gateway requests, Site SQL rows read and written, stored bytes) against a monthly workspace allowance with overage prices, in `usage_only`, `shadow` or `credits` billing mode, and a deployment-wide monthly spend brake an operator can lift with `scripts/operator/site-platform-brake.ts`. Managers see what each audience can use, readiness warnings with one-click fixes and a View as visitor preview; Site code reads `site.capabilities`. The SDK adds `applySitePublicationFix` and `getSitePlatformUsage`, and agents get `site_publication_apply_fix`.

Breaking: `agent.guestTools` is accepted but ignored. On published hosts, `not_available_for_viewer` (with the feature name) replaces `site_agents_unavailable`, `site_tools_unavailable` and audience-only Site Data and Site SQL forbidden errors. `details.legacyCode` retains the earlier code for migration; clients must explicitly adopt the new code or read that alias. Ownership refusals keep their own code. `effectiveLimits` now describes non-member limits, never a member's budget. The `free` profile is now `standard` (`free` remains an accepted alias). Limits follow the viewer. These immediate user-directed semantic changes are recorded in the API compatibility exception log, not claimed as a 90-day transition or security exception.

Migration 0790 adds platform metering, spend windows and verified conversation viewer emails. Migration 0791 is a no-write compatibility checkpoint: legacy stored kinds and overrides stay readable by old releases, with no locked backfill. New writers store standard as free. Request-time normalization ignores old-free defaults in unmarked custom overrides and preserves other owner values; new explicit overrides carry an internal version marker so intentional old-default values are preserved. Existing Sites and old-pod writes pick up the new defaults without republishing. See `docs/published-sites.md` for the exact values and compatibility mapping.

Members receive no Site budget or session usage-limit stamp. Every published-host conversation gets its own Site Data tools, viewer-bound Site SQL named queries when enabled, and member-only read-only SQL, never management tools. Site agents have no sandbox; publication settings expose no sandbox opt-in. Console-frame tools are narrowed per tool name. Non-member models are explicit and existing subscription conversations are refused. A configurable $0.25 per-turn reservation avoids consuming entire conversation caps; reservation contention returns retryable 429 `site_budget_busy`. React renders audience, budget and platform-brake refusals inline.

Migration 0790 also adds nullable pending-admission tokens. Funding stays reserved across dispatch, and enqueue transactions verify the token. Crash/unknown-outcome recovery revokes delayed requests and reconciles the locked canonical queue before refunding; neither an idle label nor a timeout can double-allocate funds.

Platform usage excludes model spend and defaults to metering only. Site SQL has no monthly row quotas by default and 5 GiB storage per Site. Publishing can return 402 `site_platform_quota_exhausted` only in credits mode and 503 `site_platform_brake_engaged` while the global brake is engaged. The `OPENGENI_SITES_FREE_*` agent settings are deprecated fallbacks for `OPENGENI_SITES_AGENT_*` and `OPENGENI_SITES_GUEST_*` settings.
