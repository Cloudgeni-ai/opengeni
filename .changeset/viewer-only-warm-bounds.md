---
"@opengeni/db": patch
"@opengeni/config": patch
"@opengeni/contracts": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Sandboxes kept warm only by open session pages can no longer be held indefinitely or without limit. When every holder of a warm box is a viewer and its sessions have no open work, the reaper now drains it after 30 minutes without use (`OPENGENI_SANDBOX_VIEWER_IDLE_DRAIN_MS`, `0` disables) and keeps at most 10 such boxes per organization (`OPENGENI_SANDBOX_MAX_VIEWER_ONLY_WARM_PER_ACCOUNT`, `0` disables): over the cap it drains the least recently active boxes that have been quiet for five minutes and refuses new viewer-only warm-ups with 429, while the session still loads without a live box. The web client reports on each viewer attach and heartbeat how long ago the person last used the page (`lastInteractionAgeMs`), so an active person with an open tab keeps their box; clients that do not report it fall back to the attach time and session activity. After an idle drain, a re-attach without newer interaction or session activity is refused, so an unattended page cannot keep a box warm; the person's next interaction re-attaches and the box resumes from its saved workspace. Drains are logged with their reason and counted in `opengeni_sandbox_viewer_only_drains_total{reason}`.
