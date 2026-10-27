---
"@opengeni/runtime": patch
---

A turn's first `tool_search` no longer reports a connected integration's tools as unavailable. Integration servers list their tools in the background while the model answers its first request. When they finished before the answer arrived, the search result was decided from the tools that first request carried, which include no deferred server, so an exact-name load of a tool that exists came back as `unavailable` and a ranked search missed it. The same call made a moment later worked. A search result is now decided only after the prepared catalog is loaded.
