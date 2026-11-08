---
"@opengeni/contracts": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
"@opengeni/react-native": patch
---

Prepare incoming voice connections while ringing only on phones with a native audio device that guarantees silence until Answer. Hold context delivery until the answering phone wins, release unused preparations silently, and retain connect-on-answer behavior on other hosts.
