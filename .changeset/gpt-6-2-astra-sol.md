---
"@opengeni/config": minor
"@opengeni/codex": minor
"@opengeni/react": patch
---

GPT-6.2 Astra (`gpt-6.2-astra`) and GPT-6.2 Sol (`gpt-6.2-sol`) replace GPT-6 Astra as Opengeni's default models. The built-in OpenAI defaults are now `OPENGENI_OPENAI_MODEL=gpt-6.2-astra` and `OPENGENI_OPENAI_ALLOWED_MODELS=gpt-6.2-astra,gpt-6.2-sol,gpt-6-sol,gpt-6-luna`, and the built-in Codex subscription models are GPT-6.2 Astra, GPT-6.2 Sol, GPT-6 Sol and GPT-6 Luna. Both new models offer Fast and, where OpenAI serves it, Ultrafast, and get compact labels ("6.2 Astra", "6.2 Sol").

Their OpenAI list prices per million tokens: GPT-6.2 Astra $8 input, $0.40 cached input, $10 cache write and $40 output; GPT-6.2 Sol $2, $0.10, $2.50 and $10. Above 272K input tokens the whole request pays twice the input and cache rates and 1.5 times the output rate. Ultrafast is priced at OpenAI's launch rate of 3 times Standard, which OpenAI raises to 6 times on 1 March 2027.

GPT-6 Astra is no longer offered by default. Deployments that list it explicitly keep it, and it keeps its price, so Azure deployments of it, accepted turns and recorded usage stay priced. Chats on it keep their history and ask for another model on the next message; database-mode catalogs retire it with `retired: true` as before. GPT-6.1 Sol is unchanged.
