---
"@opengeni/react": patch
---

Meetings menus and dialogs keep Opengeni's styling when a product embeds the meetings pages. They used to open under the host page's `<body>`, outside the scoped stylesheet, so the speaker menu, the visibility menu and the Correct the words dialog showed up unstyled and see-through. Each meetings component now opens its overlays in a styled layer that carries its theme, or in the app's own portal container when there is one.
