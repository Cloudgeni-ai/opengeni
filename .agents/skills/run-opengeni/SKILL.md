---
name: run-opengeni
description: >-
  Use when the user wants OpenGeni running on their machine, or asks how to
  configure a local OpenGeni checkout. Not for editing OpenGeni source
  (opengeni skill) or embedding it in another product (opengeni-client).
---

# Run OpenGeni

Get a local checkout running. Read `.env.example`, `docs/local-development.md`, and the repository's prerequisite checker before starting. Use `bun run dev` and the defaults already in the repo. Do not ask the user to choose a sandbox, models, or feature flags first. Preserve existing configuration, credentials, and data.

Identify the actual execution host first: an isolated agent sandbox is not the user's physical computer. The full checkout launcher supports Linux and macOS; on Windows use WSL2, with the checkout and tools inside Linux, not a mixture of Windows and WSL executables. Read `.bun-version` for the exact Bun version; an arbitrary recent Bun is not sufficient. Check available disk space, Docker daemon access (a Docker CLI alone is not enough), and the prerequisites for the selected infrastructure backend. Report all missing prerequisites together and use the repository's installation guidance. Do not improvise unverified binary mirrors or install Go merely to recover a failed MinIO download.

Keep the launcher running and wait for `OpenGeni dev stack ready`. Infrastructure health and migrations are intermediate milestones. If startup fails, inspect the failed stage, fix the cause, and restart; do not bypass runtime verification, database role checks, or source identity. Do not delete data to make startup pass. Stop only the exact launcher/process group you started, then use `bun run dev:down` for this checkout's infrastructure; never use name-wide `pkill` or `killall`.

Treat setup as done only after opening the printed web URL and checking that the application renders. With an available authorized model route, create a session, verify an assistant reply, and ask it to run a harmless command using the default sandbox (for example, print a fixed marker). A model-only session with sandbox `none` does not verify agent execution. Without credentials, verify the model-connection surface and clearly hand off the remaining connection step. A health URL alone is not done. Report any capability not actually tested.

After it is up, tell the user the actual app URL and how to connect a model. In the app, open Settings, then Models. From there they can connect a ChatGPT / Codex subscription, a SuperGrok subscription, a Vercel AI Gateway key, or an OpenRouter key. The other path is a deployment key in `.env` for the built-in OpenAI or Azure provider. `.env.example` leaves `OPENGENI_OPENAI_API_KEY` commented out and empty; do not describe a placeholder key as configured. Never print credentials. Distinguish a key supplied only to this process from one persisted for later restarts, and do not copy ambient credentials into files without authorization.

Connected Machines is optional and off for a fresh checkout; the local agent does not need its relay. The editable-artifact kernel is separate: disabling Connected Machines does not remove the kernel requirement. Follow the repository's verified runtime preparation path rather than using an unrelated binary or stale build. Preserve an existing explicit Connected Machines setting.

If they ask what else they can change, or ask to turn something on, answer from the current checkout. The usual other choice is where the agent runs. Explain the one they asked about, then change it if they want it. Leave every other default as it is.
