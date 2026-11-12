---
"@opengeni/core": patch
---

A subscription that is out of credit no longer stops dictation: with the workspace's "try another provider" setting on, the audio goes to the next provider, and the spent one is tried last for that workspace for 15 minutes.
