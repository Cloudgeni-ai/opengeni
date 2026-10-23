---
"@opengeni/react": minor
---

The Site view's chat panel no longer repeats the Site's conversation list (the sidebar already nests it under the Site row). It shows the open conversation as a regular chat with the model picker, titled in its header, with one New action. The panel can be resized by dragging its left edge or with the keyboard (320 to 720 px, always leaving the Site 360 px), hidden and shown again, and its width and hidden state are remembered per person. Adds a reusable `ResizeHandle` window-splitter primitive.
