---
"@opengeni/contracts": minor
"@opengeni/config": minor
"@opengeni/core": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
---

Meetings and dictation share one set of speech-to-text providers. Each model says what it can do and who pays for it (`funding`: a workspace key, a workspace subscription or the deployment). A workspace can transcribe meetings with its ChatGPT or Grok subscription, OpenAI or Azure OpenAI: Opengeni's diarizer separates the speakers and each speaker's speech is transcribed on its own, with approximate word timings. Dictation can use Azure Speech and ElevenLabs Scribe. `OPENGENI_SPEECH_TO_TEXT_PINNED` makes one model the only one for every use, so a deployment can guarantee where audio goes. Deployment-funded meeting transcripts are charged in credits at the model's price. `GET …/recording-models` adds each model's funding, `dictationDefault` and `pinned`. The voice input provider `azure-mai` is now `azure-speech`; the old name is still accepted.
