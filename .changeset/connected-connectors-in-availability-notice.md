---
"@opengeni/worker-bundle": patch
---

The per-turn connector availability notice now also names the chat's connectors that are connected for this turn, noting that their tools may appear only through tool search. Before, a turn with an unavailable connector named only that one, so an agent asked to use a connected service whose tools wait behind tool search could take a similarly named unavailable connector (Google Calendar beside a connected Outlook Calendar) for it and answer that the service wasn't available without searching. Connectors already reported unavailable, selections narrowed to no tools, and connectors whose every account needs reconnecting are not listed as connected. The line appears only on turns that already carry the notice.
