---
"@opengeni/react": patch
---

A meeting whose transcript failed before its audio was prepared (for example because no transcription provider was connected yet) no longer says its audio isn't available, and "Transcribe again" works on it. The meeting page now treats audio as gone only once retention deleted it or when none was ever uploaded, and no longer shows that notice while a first transcript is being made.
