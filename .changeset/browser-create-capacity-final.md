---
"@opengeni/api-router": patch
---

When an older agent reports a full browser supervisor, opening a browser now fails right away with the clear capacity message. Previously the browser session sat in "starting" for about three minutes until its transition expired, and a later open could reuse that stuck session.
