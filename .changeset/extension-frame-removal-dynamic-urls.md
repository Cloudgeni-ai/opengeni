---
"@opengeni/browser-extension": patch
---

In a person's own connected Chrome, Bitwarden's inline menu made a sign-in or checkout tab uncontrollable as soon as a field got focus: the agent got "could not be removed" on every action. Bitwarden serves its menu at a random address (`use_dynamic_url`), `chrome-extension://<random uuid>/overlay/menu.html`, and the frame removal only recognised addresses naming a 32-letter extension id, so it never found the menu. The removal now recognises any other extension's address, so the menu is removed and the tab stays controllable.
