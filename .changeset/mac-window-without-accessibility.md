---
"@opengeni/browserd": patch
---

A Mac window that macOS shows on screen but accessibility does not (some system prompts and panels) is now read from its screenshot, with no elements, instead of failing the observation as a stale target. Background input to it is still refused, since it could reach another window of the app, and the refusal now says the window is on screen and what to do instead, rather than claiming the window is no longer on screen.
