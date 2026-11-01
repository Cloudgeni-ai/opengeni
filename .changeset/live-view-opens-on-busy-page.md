---
"@opengeni/browserd": patch
---

A browser live view opened while its page is busy now shows the page once it answers. The stream's first frame used to count timeouts toward its three-failure limit, so opening the view, or following a new tab still loading a heavy page, during a busy period of more than about 6 s failed the stream. A first frame that times out now leaves the stream open, and its first frame arrives as soon as the page answers. A first frame that fails for another reason still refuses the stream.

The same now holds for a browser on a connected machine, whose view goes through the stream relay. browserd pings a frame socket once its subscription is open, and the agent counts the stream ready at that ping instead of at the first frame, which a busy page sends only once it answers. When the agent stops waiting for a stream to be ready, it now closes that stream's browserd subscription and relay channel instead of leaving them running unpaired. While a page does not answer, its live view keeps at most one layout read waiting on it rather than sending another every frame deadline.
