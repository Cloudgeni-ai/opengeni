---
"@opengeni/react-native": patch
"@opengeni/react": patch
---

Keep native chat responsive on long or crafted messages: bound Markdown input to
8,192 characters and show longer messages in selectable plain-text pages, with
every character still available. Bound math normalization too. The mobile app
pins patched Markdown/linkification and URI-decoding dependencies.
