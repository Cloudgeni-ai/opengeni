---
"@opengeni/desktop": patch
---

Recording computer audio no longer fails while macOS asks for permission. The first time a meeting recording includes computer audio, macOS asks for System Audio Recording permission and the capture waits for the answer. The app used to give up after 10 seconds, so anyone who took longer to answer saw "Recording computer audio stopped unexpectedly". The audio capture helper now says when macOS is asking (`{"event":"awaiting_permission"}`), and the app waits for the answer however long it takes, as the microphone prompt does. When the person chooses Don't Allow, the start now fails as not allowed instead of recording only silence. Both fixes need the audio capture helper from this release; with an older helper, nothing changes.
