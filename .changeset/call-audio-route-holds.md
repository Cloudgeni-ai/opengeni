---
"@opengeni/react-native": patch
---

A voice call on iPhone stays on the loudspeaker or receiver the person sees, instead of switching to the receiver by itself a few seconds in. When call audio starts, WebRTC applies its own voice-chat audio configuration, which falls back to the receiver; the call treated that as a new route and showed it. The native module now reports why the route changed (`routeChanged` carries a `reason`), and `useNativeRealtimeCall` puts audio back on the person's choice when only the session's configuration changed, while route changes from the person (the call screen, Control Center) or a device (AirPods, headphones) are kept. This covers calls started in the app and agent calls answered on the system call screen; every call starts on the loudspeaker.
