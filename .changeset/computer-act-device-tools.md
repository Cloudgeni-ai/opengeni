---
"@opengeni/runtime": patch
---

computer_act's description now says that a device simulator or emulator window (an iOS Simulator device, an Android emulator) takes pointer, scroll and keyboard input unreliably even when the action completes, and to drive such a device with its own tools (simctl or idb, adb) when available, using computer_observe to see it.
