---
"@opengeni/react": minor
---

`SessionApp` takes `resolveLink` and `renderLink`, so a host opens links in agent messages its own way (an artifact on the host's own page, its own link scheme); they are asked before the app's own handling. Object links in an embed no longer resolve against the host page's origin: with the dock on they open in the dock, and with it off (the `embed` preset) they open the object's page in the web app through `openUrl` instead of a broken host-origin link.
