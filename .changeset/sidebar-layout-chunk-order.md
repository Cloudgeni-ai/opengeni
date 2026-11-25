---
"@opengeni/contracts": patch
---

Settings → Sidebar and the rail's own items load again in the web app. An agent link's avatar and an app package's sidebar path are now read when parsing, so they no longer depend on which bundle chunk loads first; the web build's chunk-order check now also catches reads inside schema factories.
