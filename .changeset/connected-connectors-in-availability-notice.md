---
"@opengeni/worker-bundle": patch
---

The per-turn connector availability notice now also names the chat's connectors that are connected this turn. Before, a turn with an unavailable connector named only that one, so an agent asked to use a connected service whose tools wait behind tool search could take a similarly named unavailable connector (Google Calendar beside a connected Outlook Calendar) for it and answer that the service wasn't available without searching. The line appears only on turns that already carry the notice.
