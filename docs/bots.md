# Bots

A bot is an ordinary long-lived chat with a job, a name and a face. Opengeni
has no separate bot object: the chat already owns its history, goals,
schedules, event triggers, sandbox and messages from other agents, and the
workspace already shares Skills, Knowledge and connections between every chat.
A bot only adds what people need to recognise it and to start another like it.

## Name, description and avatar

Every chat may carry, alongside its title:

- a one-line **description** (up to 280 characters) of what it is for, and
- an **avatar**: one emoji, one of a curated set of icons, one or two letters,
  each on a chosen hue, or an image file in the workspace (for example one the
  agent generated).

The title is the bot's name. All three are display metadata for people. They
never enter the model's context: the description and avatar live on the
`sessions` row (migration `1008_session_bots.sql`) and their change event,
`session.profile_set`, is not projected into model history. Changing them
therefore never changes what the agent sees or invalidates its prompt cache.

People change them from the chat header (the avatar button or **Edit
profile…**) and from the sidebar's context menu, through
`PATCH /v1/workspaces/:workspaceId/sessions/:sessionId`, which now also accepts
`description` and `avatar` (only the named fields change; `null` clears one).

The agent changes them with its existing title tools: `set_session_title` for
its own chat and `set_other_session_title` for another, both of which now also
take `description` and `avatar`. A rename through either tool is a deliberate
name, like a person's: the title is cleaned like any model-written title, then
kept, so automatic titling never replaces it. The tools tell the agent to keep
a name a person or bot template chose unless the person asks for a new one.

An image avatar must be a finished image in the workspace that the writer can
open. In a chat shared with the workspace, and in any bot template, an Only me
image is refused, because everyone else would see only initials; the agent is
told to share the image first. Each viewer opens the image with their own
access, and anyone who cannot sees the name's initials instead.

Forking a chat copies its description and avatar along with its title and
agent settings (the fork routines copy the whole source row), so forking a bot
is the simple way to clone one together with its history.

## Bot templates

A bot template is where a new bot starts: a name, description, avatar and
**setup instructions**. Starting a bot from a template opens a new chat that is
exempt from the idle-session archive, already carries the template's name,
description and avatar, and has the setup instructions as its first message.
The agent then sets itself up with its ordinary tools (installing Skills,
offering plugins and connections, creating schedules and event triggers,
choosing a machine) and the chat simply continues as the bot.

Setup instructions can be exact ("install these Skills and create this
schedule") so the agent sets itself up without asking, or open-ended ("ask how
they handle on-call today and set up what fits") so the same template works for
people whose tools differ. Setup never bypasses anything: connections and
plugins still need a person's click on the card the agent shows, and Skill
installs follow the workspace's Skill settings.

Plugins from the marketplace are part of the integration catalogue the agent
already searches for connectors (`capability_catalog_search`, kind `plugin`,
ids `plugin:marketplace/<provider>/<name>`). When setup names a plugin, the
agent asks for it with `capability_authorization_request` exactly as for a
connector. The chat shows a plugin card with the agent's reason, who made the
plugin and what it adds; **Review plugin** lists its Skills and MCP servers and
installs it for the workspace. Installing needs the same `capabilities:manage`
permission as the Plugins page. Someone without it sees that a workspace admin
has to install it, and the agent is told the same, so it does not send them to
the card. The agent continues once the plugin is installed, and a plugin that
is already installed shows as done.

Templates are stored per workspace (`bot_templates`, visibility in migration
`1064_bot_template_visibility.sql`). Like a chat, each template is either
shared with the workspace, so everyone can start bots from it, or **Only me**,
so only whoever saved it can see, find or use it. A template the agent saves
from an Only me chat is Only me; one saved from a shared chat is shared. People
choose in the template dialog and can change it later. A shared template is
shared work, like a shared Skill or Site: anyone who may start chats in the
workspace (`sessions:create`) may change or delete it, but only whoever saved
it or a workspace admin may make it Only me; each template's
`viewerCanMakePrivate` says whether the reader may, and the Edit dialog offers
Only me only then. An Only me template belongs to the
person who saved it. Routes:

| Route | Needs |
| --- | --- |
| `GET /v1/workspaces/:workspaceId/bot-templates` and `/:templateId` | `sessions:read` |
| `POST /v1/workspaces/:workspaceId/bot-templates` | `sessions:create`; a `sourceSessionId` must be a chat in the workspace the caller can open |
| `PATCH` and `DELETE /v1/workspaces/:workspaceId/bot-templates/:templateId` | `sessions:create`, and manage access |

A workspace keeps at most 200 templates.

In the web app, **Bot templates** sits in the sidebar's More section, next to
Automations; once a workspace has templates, the new-chat page also shows them
under the composer as one-tap "Start a bot" shortcuts. Starting one shows the
template above the composer with its setup instructions filled in; closing that
strip (or leaving the page) takes the untouched instructions out again, so they
never become an ordinary chat's first message by accident.

The agent saves a template of itself with `bot_template_save` (capability
`subagents`, needs `sessions:create`), usually when the person asks. It writes
the setup instructions from what the chat has established and leaves out
one-off tasks, history, personal details and secrets.

### Sharing a template as a file

A template exports as a small JSON file and imports into any workspace as a new
template:

```json
{
  "format": "opengeni.bot-template",
  "version": 1,
  "name": "SRE bot",
  "description": "Watches production and handles alerts",
  "avatar": { "kind": "icon", "icon": "shield-check", "hue": 200 },
  "setupInstructions": "Ask how they deploy and get paged today, then ..."
}
```

The file carries no ids, owner, visibility or image: an image avatar stays in
its workspace and is dropped on export. An imported template is shared with
the workspace; make it Only me from its **Edit** dialog.

## In Slack

When the workspace's Slack app has the optional `chat:write.customize` grant, a
bot posts its own replies in Slack under its name and avatar instead of the
app's: progress, answers and results in its threads, and messages it prepares
for a channel or a scheduled task. Approvals, limits and other notices stay the
app's, and Slack labels every such post as an app message, so readers can tell
it is not a person. Only a chat with an avatar posts this way; others post as
the app. See [Slack bot](slack-bot.md) for the grant and the signed avatar
picture URL.
