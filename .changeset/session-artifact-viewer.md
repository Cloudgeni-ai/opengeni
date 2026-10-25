---
"@opengeni/react": minor
---

Clicking an image or file in a session's Artifacts panel opens a full-window viewer that steps through the listed artifacts in their current order, respecting search and filters, with Previous and Next buttons, Left and Right arrow keys, swipe on touch, an "N of M" position and Escape to close. Neighbouring images are preloaded, and other artifacts show their existing preview inside the viewer.

Images in that viewer and in the chat screenshot lightbox can be zoomed and panned: they open fitted (small ones enlarged up to 2x), zoom with Cmd/Ctrl + plus and minus, Cmd/Ctrl + wheel, pinch or the new zoom buttons with a percentage, fit again with Cmd/Ctrl + 0 or Fit, toggle fitted and actual size on click, and pan by dragging or scrolling. While an image is shown, the zoom keys zoom the image rather than the page or desktop window. `LightboxControlLabels` accepts `zoomIn`, `zoomOut` and `fit` labels.
