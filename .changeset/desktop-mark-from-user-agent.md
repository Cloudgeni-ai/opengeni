---
"@opengeni/react": patch
---

The Opengeni desktop app's pages keep room for the window controls even when the shell's bridge doesn't reach the page. `desktopPlatform` takes the platform from the bridge, or from the app's user agent (`Opengeni/<version> … Electron/<version>`), and `installDesktopShell` marks the document from it. Layout choices (`windowControlsInPage`, the rail's width and drawer breakpoint) follow it; desktop capabilities still come only from the bridge. On macOS, a full-window Site's Back no longer falls under the traffic lights when the bridge is missing.
