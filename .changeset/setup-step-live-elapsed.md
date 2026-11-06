---
"@opengeni/react": patch
"@opengeni/react-native": patch
---

A running startup step in the chat timeline now says how long it has been running, updated every second in its title the way the turn header does ("Preparing runtime and model request · 1m 21s"), and a running environment setup step names the environment ("Setting up cloudgeni"). Before, a long environment setup showed only "Setting up sandbox environment" with no time, so a slow setup looked stuck. Startup phase items carry a new optional `subject`, the environment name from `rig.setup.*` events. Settled steps keep their final duration.
