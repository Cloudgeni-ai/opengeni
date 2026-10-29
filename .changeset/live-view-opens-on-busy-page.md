---
"@opengeni/browserd": patch
---

A browser live view opened while its page is busy now shows the page once it answers. The stream's first frame used to count timeouts toward its three-failure limit, so opening the view, or following a new tab still loading a heavy page, during a busy period of more than about 6 s failed the stream. A first frame that times out now leaves the stream open, and its first frame arrives as soon as the page answers. A first frame that fails for another reason still refuses the stream.
