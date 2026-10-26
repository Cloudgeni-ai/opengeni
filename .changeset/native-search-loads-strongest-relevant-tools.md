---
"@opengeni/runtime": patch
---

On native tool-search routes, a search whose ranking finds relevant tools but no single clear best (an exact tie, or no resource word in the top tool's name and capability sentence) now loads the strongest relevant tool and any tied with it, within the limit, instead of returning nothing. A query that matches no tool's name or capability sentence still loads nothing, and generic dispatch routes keep listing compact candidates. The other-connected-accounts notice now also follows the turn's first load by exact names that reaches one of several connected accounts.
