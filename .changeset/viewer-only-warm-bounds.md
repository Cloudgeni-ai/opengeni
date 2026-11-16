---
"@opengeni/db": patch
"@opengeni/config": patch
"@opengeni/contracts": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Sandboxes kept warm only by open session pages can no longer be held indefinitely or without limit. When every holder of a warm box is a viewer and its sessions have no open turn, the reaper now drains it after 30 minutes without use (`OPENGENI_SANDBOX_VIEWER_IDLE_DRAIN_MS`, `0` disables) and keeps at most 10 such boxes per organization, draining the least recently active first (`OPENGENI_SANDBOX_MAX_VIEWER_ONLY_WARM_PER_ACCOUNT`, `0` disables). A viewer attach that would warm another such box over the cap gets 429 and the session loads without a live box. The web client reports on each viewer heartbeat how long ago the person last used the page (`lastInteractionAgeMs`), so an active person with an open tab keeps their box; clients that do not report it fall back to the attach time and session activity. A page released while its person was away re-attaches on their next interaction and the box resumes from its saved workspace. Drains are logged with their reason and counted in `opengeni_sandbox_viewer_only_drains_total{reason}`.
