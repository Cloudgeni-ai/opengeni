---
"@opengeni/react-native": patch
---

`useNativeRealtimeCall` keeps talking when the system refuses the call (no CallKit in the region, the simulator): voice starts as an in-app call, and the new `systemCall` field says whether the system shows it.
