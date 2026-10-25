---
"@opengeni/browserd": patch
"@opengeni/contracts": patch
"@opengeni/runtime": patch
"@opengeni/api-router": patch
---

Windows computer use can type into and click the app it just opened. Before input, the Windows backend brings the target window to the front itself: it dismisses Start or Search if one of them holds the foreground, restores a minimized window, activates it while attached to the foreground thread, and as a last resort clicks the window's own title bar. Only when all of that fails does it refuse, naming the window that kept the front, and none of the action's input is sent. After keyboard input the foreground goes back to the window that had it, as CUA itself does; a window that was clicked stays in front, as after CUA's own clicks, and a dismissed Start or Search is not reopened. A Windows "window was not in front" error from CUA is reported as retryable with nothing sent only when CUA says no input was sent; after a click CUA already sent, it is an unknown outcome to check before acting again.

The Windows CUA tool catalog is regenerated from the bundled CUA 0.37 driver, so the native `cua_*` tools no longer fail with "CUA tool schema differs from this release". Each generated catalog now records the CUA version it came from, and a test fails unless every catalog names the `@trycua/cua-driver` version browserd pins.

`computer_open` accepts `includeScreenshot`, like `browser_open`: the result then also carries a still image of the screen with its frame id and pixel size. With several screens it captures the one the computer works in, else the focused one or the one showing the focused window, and it returns no image when the screen changed while it was captured.

A rejected computer session request body now names the first rejected field, for example `invalid request body: expectedFrameId: pointer action frameId must match expectedFrameId`.
