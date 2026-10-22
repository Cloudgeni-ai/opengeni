---
"@opengeni/react-native": minor
---

Native chat Markdown can now draw the host's own links, like `renderLink` on the web. Pass `renderLink` to `createWebMarkdownRenderer` to draw links with your own scheme (`myapp:order/42`), in-app paths or web URLs yourself; return `undefined` to keep the default link. A link that is the only content of its paragraph or list item arrives with `standalone: true` and may be drawn as a block, such as a card. Inline links sit inside text, so draw them with `Text`. Opengeni object links (`artifact:`, `sandbox:`) still go to `onOpenGeniLink`.
