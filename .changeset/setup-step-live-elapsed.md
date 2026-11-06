---
"@opengeni/react": minor
"@opengeni/react-native": patch
---

A running startup step in the chat timeline now shows how long it has been running, updated every second, and a running environment setup step names the environment, such as "Setting up the cloudgeni environment". Before, a long environment setup showed only "Setting up sandbox environment" with no time, so a slow setup looked stuck. Startup phase items carry a new optional `subject` (the environment name from `rig.setup.*` events), and `startupElapsed` from `@opengeni/react` formats an elapsed time as whole seconds or minutes and seconds ("41s", "1m 05s"). Settled steps keep their final duration.
