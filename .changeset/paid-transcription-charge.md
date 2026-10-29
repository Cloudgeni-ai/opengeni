---
"@opengeni/core": patch
"@opengeni/db": patch
---

Live transcripts on a model the deployment pays for now cost credits while credit billing is active: the payer is admitted before the live secret is minted (402 without credits), and each track's newly streamed audio is charged once at the model's voice price. A live model with no credit price isn't served then. The deployment's Azure Speech account without a voice input MAI price (OPENGENI_VOICE_INPUT_MAI_PRICING_JSON) isn't offered for meetings while credits are billed, instead of transcribing them free.
