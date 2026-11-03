---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/desktop": minor
---

Each desktop dictation shortcut can pick its own speech-to-text model, such as one for English and another for Norwegian. The client config lists the models a dictation can use (`voiceInput.models`), a dictation recording may name its `providerId` and `model`, and it is then heard by exactly that model with no fallback to another provider. Escape no longer cancels a dictation, on the desktop or in the composer: only the Cancel button and the cancel shortcut do, so a stray Escape never loses speech or is taken from the app being typed in. The dictation window no longer draws a drop shadow around its pill.
