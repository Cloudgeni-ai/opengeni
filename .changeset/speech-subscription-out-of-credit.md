---
"@opengeni/core": patch
"@opengeni/react": patch
"@opengeni/react-native": patch
---

A subscription speech service that is out of credit now says so. Subscription transcription reads the provider's refusal instead of discarding it, so xAI's "run out of credits" answer becomes an out-of-credit error rather than a generic failure; a failed dictation keeps that reason, and the composer and phone dictation tell you the speech-to-text service is out of credit. Phone dictation no longer says to retry when you're back online after the speech service itself failed.
