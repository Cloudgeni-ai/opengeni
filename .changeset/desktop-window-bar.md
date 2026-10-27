---
"@opengeni/desktop": patch
"@opengeni/react": patch
---

The desktop app has a thin bar across the top of the window for the window controls: the macOS traffic lights (and the wider badge macOS shows while the window is shared or recorded) and the Windows caption buttons. The page starts below it, so nothing is drawn under the controls in any layout, and the collapsed rail stays narrow.

- `@opengeni/desktop`: the macOS traffic lights are centred in the 44px bar, and the Windows caption buttons are 44px tall.
- `@opengeni/react`: the session rail keeps its brand row on every platform. Layers that fill the window (a full-window Site or panel, the image viewer, side sheets) carry `data-window-layer`, so a host can start them below its own window bar. `windowControlsInPage` is deprecated.
