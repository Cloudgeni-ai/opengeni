---
"@opengeni/react-native": patch
"@opengeni/react": patch
---

Long chat messages in the native app render formatted again, like on the web: bold,
lists, links, math and inline `opengeni-html` / `opengeni-site` previews, instead of
raw text pages. A long message is cut where markdown-it starts a top-level block, so
every chunk parses to the same blocks as the whole message, and each chunk is
math-normalized and parsed on its own (at most 8,192 characters per parse) and
mounted one chunk-sized slice per frame. A visual too long to share a chunk goes to
the preview renderer whole; other code blocks longer than one chunk show as pages.
While a message streams, only its last blocks are parsed again.
Messages over 65,536
characters, and a single text block too long for one chunk, still show as selectable
plain-text pages.

Math in chat Markdown (web and native) finds display blocks in linear time: many
unclosed `$$` or `\[` openers no longer make the math pass quadratic. Output is
unchanged.
