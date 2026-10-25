---
"@opengeni/config": patch
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Turns funded by Opengeni credits can now generate and edit images. When no turn-native, subscription or workspace Gateway route applies, the agent gets `generate_image` through the deployment's Vercel AI Gateway key and `imageGenerationModel`, priced per image (`OPENGENI_IMAGE_GENERATION_CREDIT_MICROS_PER_IMAGE`, or the built-in price for `openai/gpt-image-2`). It is on by default once the key and a price exist; `OPENGENI_IMAGE_GENERATION_OPENGENI_CREDITS_ENABLED=false` turns it off, and workspaces with Opengeni credits turned off are not offered it.

Before any provider request, each image must fit the workspace and member allowance and the spendable balance, which includes plan and trial grants covering the turn's chat model, minus images of the workspace still in flight. A refusal is returned to the agent as a plain rejected result instead of failing the turn. The image is debited once, in the same transaction that makes it ready. Migrations 0968 to 0970 (rolling) add the price, credit state and usage model to `image_generation_operations`, plus an index for in-flight images. The workspace Gateway image route now finds the workspace key by provider id.
