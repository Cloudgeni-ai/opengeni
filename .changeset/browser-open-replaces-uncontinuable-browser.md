---
"@opengeni/runtime": patch
---

A default `browser_open` (no `browserSessionId`, default reuse) no longer fails on a browser that can never be continued. When the browser it picks for reuse is refused and inspecting its working copy shows it can never be continued (its last launch left no record of a browser process, it was launched under another controller, or its working directory is missing), the open starts a new browser instead and its result says which browser was replaced and why. The old browser is kept, and an open that names it by ID still reports why it cannot continue. A copy that can be adopted, an adoption still settling, or a copy a process may still use are not replaced.
