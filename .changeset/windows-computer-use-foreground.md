---
"@opengeni/browserd": patch
"@opengeni/contracts": patch
"@opengeni/runtime": patch
"@opengeni/api-router": patch
---

Windows computer use can type into and click the app it just opened. Before input, the Windows backend brings the target window to the front itself: it dismisses Start or Search if one of them holds the foreground, restores a minimized window, activates it while attached to the foreground thread, and as a last resort clicks the window's own title bar. Only when all of that fails does it refuse, naming the window that kept the front, and no input is sent.

The Windows CUA tool catalog is regenerated from the bundled CUA 0.37 driver, so the native `cua_*` tools no longer fail with "CUA tool schema differs from this release". A test now fails when a platform catalog is left on an older CUA release.

`computer_open` accepts `includeScreenshot`, like `browser_open`: the result then also carries a still image of the screen with its frame id and pixel size.

A rejected computer session request body now names the first rejected field, for example `invalid request body: expectedFrameId: pointer action frameId must match expectedFrameId`.
