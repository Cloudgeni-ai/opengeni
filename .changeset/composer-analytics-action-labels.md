---
"@opengeni/react": patch
---

Mark the composer send and pause buttons and the queued-prompt Steer buttons
with a stable `data-analytics-action` attribute (`send`, `pause`, `steer`) that
a host's product analytics can read. The attribute is inert, and a host can
override it on `SendButton` and `PauseButton` through their props.
