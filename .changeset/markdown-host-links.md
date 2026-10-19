---
"@opengeni/react": minor
---

Products can draw their own links in agent replies. Pass `renderLink` to `Markdown` or `OpenGeniLinkProvider` and links the agent writes with your scheme (`myapp:order/42`), in-app paths or web URLs reach you with the exact `href`, the link text and whether the link stands alone on its line, so you can show a chip or a card that opens in place. A paragraph holding a standalone link renders as a block so a card is valid there. Returning `undefined` keeps the default link. Without `renderLink`, nothing changes.
