---
"@opengeni/api-router": patch
---

The background renewal that keeps an agent's held browsers running no longer counts toward `opengeni_attached_browser_unavailable_total`. When a held browser sits in a person's own Chrome whose machine has gone offline, every two-minute renewal pass was counted as a refused browser operation, so the attached-browser alert fired although no agent or person saw a refusal. The renewal still skips such a browser and logs `browser.hold_failed`; refusals that an agent or person sees are counted as before.
