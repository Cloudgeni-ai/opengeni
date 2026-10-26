---
"@opengeni/runtime": patch
---

On native tool-search routes, a search whose ranking finds relevant tools but no single clear best (an exact tie, or no resource word in the top tool's name and capability sentence) now loads the strongest relevant tool and any tied with it, within the limit, instead of returning nothing. A relevant tool has the query's operation, when it names one, and a query resource word in its own name or capability sentence or among its connected integration's own words. A query that shares only a verb with a tool, or matches nothing, still loads nothing, and generic dispatch routes keep listing compact candidates. The other-connected-accounts notice now also follows the turn's first load by exact names that reaches one of several connected accounts.
