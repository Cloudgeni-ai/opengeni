---
"@opengeni/contracts": patch
"@opengeni/observability": patch
"@opengeni/react": patch
---

A page in the Opengeni desktop app's own window that lacks the shell's bridge now reports it once per page load as the `desktop_bridge_missing` client signal, with the platform and the app version from its user agent. The API counts it in `opengeni_client_desktop_bridge_missing_total{platform}` and logs the version. The account menu no longer offers to download the desktop app inside the app when the bridge is missing; it follows the same desktop decision as the layout (`desktopPlatform`). A window the app opens with `openBlankTab` is named so it keeps the web layout, like other windows the page opens. `desktopPlatformIn` exposes that decision for a given window.
