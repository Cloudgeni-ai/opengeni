---
"@opengeni/browser-extension": patch
---

The extension popup now keeps its connection state current while it is open. It used to show the state from the moment it opened, so opening it while the agent was still starting or the native host was still connecting left it saying the agent was unavailable even after the profile connected.
