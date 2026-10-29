---
"@opengeni/core": patch
"@opengeni/db": patch
---

Live transcripts on a model the deployment pays for now cost credits while credit billing is active: the payer is admitted before the live secret is minted (402 without credits), and each track's newly streamed audio is charged once at the model's voice price. A live model with no credit price isn't served then. The deployment's Azure Speech account without a voice input MAI price (OPENGENI_VOICE_INPUT_MAI_PRICING_JSON) doesn't transcribe meetings while credits are billed (the transcript fails saying the model isn't available, or an automatic choice moves to a model the deployment doesn't pay for), instead of transcribing them free. Legacy billing accounts (OPENGENI_BILLING_LEGACY_ACCOUNT_IDS, CloudGeni) keep today's behaviour for both.
