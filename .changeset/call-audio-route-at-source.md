---
"@opengeni/react-native": patch
---

iOS voice calls keep their audio route when voice starts. WebRTC used to apply its own audio session configuration (without the loudspeaker option) once call audio came up, which moved a loudspeaker call to the receiver a few seconds in. The call module now gives WebRTC the call's own configuration (and updates it when the person switches the speaker), so WebRTC finds the session already set up and changes nothing. The JavaScript workaround that switched the speaker back afterwards is removed; the call screen shows the actual route.
