---
"@opengeni/react": patch
---

The image lightbox closes on any click outside the image, at every zoom level, including the dark space right beside the image, the gutters around it and its caption. Before, once the image was zoomed, a click beside it zoomed it back instead. The zoom cursor now sits on the image and always shows what a click will do (zoom-in when a click enlarges, zoom-out when it shrinks); the backdrop keeps a plain arrow. In a desktop (Electron) shell, the whole lightbox opts out of window-drag regions, so a draggable title bar underneath no longer swallows presses on the close button or the backdrop. Its round buttons show hover and press feedback. `ZoomPanSurface` no longer zooms on a click beside the image; it calls `onBackdropClick` when given one and otherwise does nothing.
