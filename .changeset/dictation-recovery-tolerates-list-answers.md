---
"@opengeni/sdk": patch
"@opengeni/react": patch
---

Opening a composer no longer throws an unhandled `Cannot read properties of undefined (reading 'map')` when the saved-dictation lookup gets a success answer that is not a recordings list, such as a host proxy or test double answering `GET /recordings` with another route's body. `OpenGeniRecordingsClient.listRecordings` now checks the answer and rejects anything without a `recordings` array of recordings with ids as an `OpenGeniApiError` with code `invalid_response` (a missing or malformed `nextBefore` reads as the end of the list). `useVoiceInput` also tolerates a host's own recordings client that resolves without a list, and its background recovery never rejects: the composer stays as it is and a saved dictation is offered by the next composer. The recordings and transcription docs say what a custom proxy or stub must answer.
