---
name: run-opengeni
description: >-
  Use when the user wants OpenGeni running on their machine, or asks how to
  configure a local OpenGeni checkout. Not for editing OpenGeni source
  (opengeni skill) or embedding it in another product (opengeni-client).
---

# Run OpenGeni

Get OpenGeni running with the repository defaults. Make routine setup decisions yourself; the user can customize it once it works.

1. Clone `https://github.com/Cloudgeni-ai/opengeni` or use the existing checkout. Install the Bun version in `.bun-version`. On Windows, run setup inside WSL2; on macOS, have Docker running.
2. Run `bun run dev:check` and resolve the prerequisites it reports. On Linux without Docker, `bun run dev:tools -- --install` installs the local service tools; PostgreSQL 17 with pgcrypto and pgvector needs host packages. See `docs/local-development.md` for platform-specific help.
3. Run `bun run dev`. It prepares the checkout and starts the app. Wait for `OpenGeni dev stack ready` and keep it running.
4. Open the printed web URL and check that the app renders. If a model connection is available, send a message and ask the agent to run a simple command to confirm it works. Otherwise, show the user where to connect one under **Settings → Models**.

Give the user the working app URL and any remaining setup step. To stop, interrupt `bun run dev`, then run `bun run dev:down`. To start again, run `bun run dev`.
