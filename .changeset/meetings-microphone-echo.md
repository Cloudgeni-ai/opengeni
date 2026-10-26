---
"@opengeni/core": patch
---

Meeting transcripts no longer repeat what the others in a call said. When a recording has computer audio and the person recording has no headphones, the microphone also hears the others from the speakers, so their words showed up twice: once from computer audio and again as if the person recording had said them. The transcript now leaves out microphone words that were said at the same moment in computer audio (runs of at least two matching words within 1.5 seconds, allowing a misheard word or two). What the person says, even right after someone else, stays. `withoutMicrophoneEchoes` in `@opengeni/core` does this before the transcript's segments are built.
