---
"@opengeni/react-native": patch
---

Android in-app calls start voice about 0.7 seconds sooner. The call no longer waits for the system to move its audio to the loudspeaker before voice setup begins; the route settles while the connection is set up, before any voice audio plays.
