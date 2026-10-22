---
"@opengeni/react": patch
---

Typing in the composer and streaming replies no longer restyle the whole page. Several stylesheet rules used `:has()` on an element other than the one being styled (the composer footer's voice states, the macOS title bar beside a collapsed sidebar, connect-form labels, and the avatar group count), which made Chromium recompute styles for every element on each DOM change: about 35 ms per keystroke in a long chat. The composer footer now carries `data-footer-transcription-capturing`, `data-footer-transcription-attention` and `data-footer-realtime-attention` itself, the session shell carries `data-rail-collapsed`, and `AvatarGroupCount` takes a `size` prop instead of inferring it. A test keeps such selectors out.
