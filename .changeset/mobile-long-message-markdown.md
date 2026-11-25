---
"@opengeni/react-native": patch
---

Long chat messages in the native app render formatted again, like on the web: bold,
lists, links, math and inline `opengeni-html` / `opengeni-site` previews, instead of
raw text pages. A long message is parsed in chunks of at most 8,192 characters, cut
between top-level blocks, and a code fence at the start of a line is drawn directly
(a visual of any size reaches the preview renderer whole). While a message streams,
only its last chunk is parsed again. Messages over 65,536 characters, and a single
block too long for one chunk, still show as selectable plain-text pages.
