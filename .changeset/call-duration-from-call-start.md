---
"@opengeni/react-native": minor
---

A call's elapsed time no longer restarts when a minimized call is expanded again. The call screen counted from when it mounted, and minimizing unmounts it (on iOS and Android), so every expand started again at 0:00; a reconnect restarted it too. `useNativeRealtimeCall` now returns `connectedAt`, the moment voice first went live (when the system call is reported connected), and the time counts from there. The on-call pill from `NativeAgentCallProvider` shows the same running time, and `useNativeCallDuration(call)` with `formatNativeCallDuration` gives a host's own call indicator the same time.
