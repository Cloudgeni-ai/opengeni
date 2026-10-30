---
"@opengeni/core": patch
---

A call heard through the speakers no longer becomes extra people on the microphone. Since every track is diarized, a meeting recorded without headphones could show the echo of the call as new "Speaker N" voices on the microphone, made of the few words echo removal didn't catch. `withoutMicrophoneEchoes` now marks a microphone voice whose spoken time was at least 80% echo in `echoSpeakers`, and `withRecorderVoice` never picks such a voice over a real one as the person recording and drops what the echo left of it. A single voice on the microphone stays whole, as before.
