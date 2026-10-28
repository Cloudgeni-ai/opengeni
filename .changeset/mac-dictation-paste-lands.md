---
"@opengeni/desktop": patch
---

On macOS, dictation from anywhere now types the text every time. The app pastes the text with Command-V, and the helper used to press and release the keys in the same instant and quit straight away, which macOS sometimes dropped: on a real Mac about one dictation in five was transcribed and kept in Recent dictations but never typed. The helper now holds the keys for a moment, as a person would, and waits briefly before it quits; twenty pastes in a row all landed.
