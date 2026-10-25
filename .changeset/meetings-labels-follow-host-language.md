---
"@opengeni/contracts": patch
"@opengeni/react": patch
---

Meetings pages now show every label in the host's language. Recording lengths ("45 sec"), list states ("Uploading", "Transcribing"), transcript error advice, default speaker names ("Speaker 2", "Microphone", "Shared audio"), the default meeting title and dates come from the message catalog and locale under new `meetings.recordings.*` keys, and language names follow the locale ("Norsk bokmål" in Norwegian). The `@opengeni/react/recordings` helpers take an optional `OpenGeniText` and keep their English output without one. `@opengeni/contracts` adds `recordingSpeakerDefault`, which says what an unnamed speaker label is, so a client can name it in its own language.
