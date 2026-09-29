---
"@opengeni/react": patch
---

Diff and file views already on screen upgrade to highlighted rendering when a
host registers `@pierre/diffs` later, so hosts can call `enablePierreDiffs()`
from the lazily loaded route that renders diffs instead of at startup. The
OpenGeni console now does this, keeping the peer and its highlighter out of
the initial bundle.
