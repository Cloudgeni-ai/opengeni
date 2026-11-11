---
"@opengeni/browser-extension": patch
---

In a person's own connected Chrome, a password manager's inline menu (Bitwarden, for example) on a page that also holds a frame still loading (an ad or tracker whose server does not answer) left the tab uncontrollable: Chrome held the extension's frame-removal script back until every frame had loaded, the removal timed out after 3 s with the menu still there, and the agent got "could not be removed". The removal's scripts now run at once in every frame, and the search for menus created blank runs only when none was found by its address, so a slow search can no longer stop the plain removal.
