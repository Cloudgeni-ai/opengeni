---
"@opengeni/api-router": minor
"@opengeni/contracts": minor
"@opengeni/config": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/sdk": minor
"@opengeni/runtime": minor
"@opengeni/worker-bundle": minor
---

Published Site limits now follow the viewer. Workspace members have no Site caps, only the flood brakes, and keep the embedded agent even when it is off for everyone else. Invited and signed-in people share one Site spend limit ($10 a month by default, or a daily limit) with an optional per-person limit; guests also meet the bot guards (20 conversations per visitor per day, 500 per Site per day, 50 turns and $1 per conversation). Workspace tools reach only members who may use connections, and outsiders never get a subscription-billed model: they use the workspace's credit-billed default or are refused. Sites also meter platform usage (gateway requests, Site SQL rows read and written, stored bytes) against a monthly workspace allowance with overage prices, in `usage_only`, `shadow` or `credits` billing mode, and a deployment-wide monthly spend brake an operator can lift with `scripts/operator/site-platform-brake.ts`. Managers see what each audience can use, readiness warnings with one-click fixes and a View as visitor preview; Site code reads `site.capabilities`. The SDK adds `applySitePublicationFix` and `getSitePlatformUsage`, and agents get `site_publication_apply_fix`.

Breaking: `agent.guestTools` is accepted but ignored. On published hosts, `not_available_for_viewer` (with the feature name) replaces `site_agents_unavailable`, `site_tools_unavailable` and the Site Data and Site SQL forbidden errors for features the viewer's audience cannot use. The `free` limit profile is now `standard` (`free` is still accepted as an alias, and migration 0786 renames stored profiles). Default limits changed, and Site SQL has no monthly row quotas by default with 5 GiB of storage per Site. The console's limit profile editor is replaced by per-audience limits. Publishing can now return 402 `site_platform_quota_exhausted` in credits mode and 503 `site_platform_brake_engaged` while the brake is engaged. The `OPENGENI_SITES_FREE_*` agent settings are deprecated fallbacks for the new `OPENGENI_SITES_AGENT_*` and `OPENGENI_SITES_GUEST_*` settings.
