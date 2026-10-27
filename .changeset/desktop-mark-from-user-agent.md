---
"@opengeni/react": patch
---

The Opengeni desktop app's pages keep room for the window controls even when the shell's bridge doesn't reach the page. `desktopPlatform` takes the platform from the bridge, or from the app's user agent (`Opengeni/<version> … Electron/<version>`) in the app's own window; a window the page opened, which has the system title bar, and a page in a frame keep the web layout. `installDesktopShell` marks the document from it. Layout choices (`windowControlsInPage`, the rail's width and drawer breakpoint) follow it; desktop capabilities still come only from the bridge. On macOS, a full-window Site's Back no longer falls under the traffic lights when the bridge is missing.
