---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/db": minor
"@opengeni/core": minor
---

Bots. Any chat can now have a one-line description and an avatar (an emoji, an icon, letters, or an image from the workspace) next to its title, which is its name. People set them from the chat header and the sidebar menu; the agent sets them with `set_session_title` and `set_other_session_title`. They are display-only and never sent to the model. `PATCH /sessions/{id}` accepts `description` and `avatar`, and `createSession` accepts `profile`.

Bot templates (`/bot-templates`) hold a name, description, avatar and setup instructions. Starting a bot from one opens a kept-live chat with the instructions as its first message, and the agent sets itself up from there. The agent can save itself as a template with the new `bot_template_save` tool, and templates export and import as `opengeni.bot-template` files. See `docs/bots.md`.
