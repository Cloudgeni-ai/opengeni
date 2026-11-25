---
"@opengeni/react-native": patch
"@opengeni/react": patch
---

Long chat messages in the native app render formatted again, like on the web: bold,
lists, links, math and inline `opengeni-html` / `opengeni-site` previews, instead of
raw text pages. A long message is cut between top-level blocks into chunks that are
math-normalized and parsed on their own (at most 8,192 characters per parse), and is
mounted one chunk-sized slice per frame. A visual too long to share a chunk goes to
the preview renderer whole; other code blocks longer than one chunk show as pages.
While a message streams, unchanged chunks are not parsed again. Messages over 65,536
characters, and a single text block too long for one chunk, still show as selectable
plain-text pages.

Math in chat Markdown (web and native) finds display blocks in linear time: many
unclosed `$$` or `\[` openers no longer make the math pass quadratic. Output is
unchanged.
