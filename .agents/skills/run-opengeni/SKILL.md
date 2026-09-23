---
name: run-opengeni
description: >-
  Use when the user wants OpenGeni running on their machine, or asks how to
  configure a local OpenGeni checkout. Not for editing OpenGeni source
  (opengeni skill) or embedding it in another product (opengeni-client).
---

# Run OpenGeni

Get a local checkout running. Read `.env.example`, `docs/local-development.md`, and `scripts/dev-stack.sh`, and follow those. Start with `bun run dev` and the defaults already in the repo. Do not ask the user to choose a sandbox, models, or feature flags first.

Treat it as done only when a session returns an assistant message, or the app is up and the user still needs to connect a model. A health URL is not done. If startup fails, fix it and start again.

After it is up, tell the user the app URL and how to connect a model. In the app, open Settings, then Models. From there they can connect a ChatGPT / Codex subscription, a SuperGrok subscription, a Vercel AI Gateway key, or an OpenRouter key. The other path is a deployment key in `.env` for the built-in OpenAI or Azure provider. The copied file has `OPENGENI_OPENAI_API_KEY=your-key` until they replace it.

If they ask what else they can change, or ask to turn something on, answer from the current checkout. The usual other choice is where the agent runs. Explain the one they asked about, then change it if they want it. Leave every other default as it is.
