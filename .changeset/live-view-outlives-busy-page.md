---
"@opengeni/browserd": patch
---

A browser live view now comes back by itself after its page was busy for a while. A page whose main thread is busy answers none of the commands a frame needs, and three frames that timed out (about 6 s) used to end the frame stream for good, so a page busy for longer froze the live view for the rest of the session even after it became responsive again. Frames that time out no longer count toward ending the stream: it keeps sampling the tab and shows it again as soon as the page answers. The same holds for a tab its browser is not drawing yet, such as one behind another tab in a person's own Chrome. The stream still ends when its tab closes, its browser goes away, or frames keep failing for any other reason.
