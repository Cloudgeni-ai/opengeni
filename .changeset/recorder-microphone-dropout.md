---
"@opengeni/sdk": patch
"@opengeni/react": patch
---

A browser meeting recording no longer silently stops when the microphone goes away mid-meeting (unplugged, a Bluetooth headset switching profile when a call starts, the system moving the input to another device). The recorder opens the microphone again, the one chosen if it is back, else the current default, and goes on recording the same track; the server already places each new capture session at its own start time. While no track can record, the clock stops and the recorder reports `paused` with `pauseReason: "interruption"`, retrying on every device change and every few seconds, and the Meetings recorder says "Microphone disconnected" instead of showing a running clock over nothing. A microphone recorder that hands over no audio for six timeslices is treated the same way.
