---
"@opengeni/core": patch
"@opengeni/config": patch
---

Meetings can run on speech-to-text models that return only text. With `OPENGENI_RECORDING_WORD_ALIGNMENT=true` (set in the stock images), the worker hears each track whole or in the largest pieces the model takes, then places the returned words on the audio with a CPU forced aligner (Omnilingual ASR CTC, about 1,600 languages), and takes speakers from Opengeni's diarizer. `speechToTextServesMeetings` says whether a model can serve meetings on a deployment, and the worker reports an `align` stage with placement and fit metrics.
