# Bots

A bot is an ordinary long-lived chat with a job, a name and a face. Opengeni
has no separate bot object: the chat already owns its history, goals,
schedules, event triggers, sandbox and messages from other agents, and the
workspace already shares Skills, Knowledge and connections between every chat.
A bot only adds what people need to recognise it and to start another like it.

## Name, description and avatar

Every chat may carry, next to its title:

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

## Mentioning a bot

Typing `@` at the end of a message in a running chat lists the workspace's
bots (chats with a description or avatar, found by name), and picking one
writes `@Name`. When the message is sent, each mentioned bot's chat id travels
as the message's context (`modelContext`), with one line telling the agent to
send the request to that bot's chat with `session_send_message` and follow its
result. The bot does the work in its own chat, with its own history and setup,
instead of the sender starting over. A mention grants nothing: the agent's
ordinary session authority applies, and a bot mentioned in its own chat simply
does the work there. See `packages/react/src/app/components/bots/bot-mention.tsx`.

## Bot templates

A bot template is where a new bot starts: a name, description, avatar and
**setup instructions**. Starting a bot from a template opens a new chat that is
exempt from the idle-session archive, already carries the template's name,
description and avatar, and has the setup instructions as its first message.
The agent then sets itself up with its ordinary tools (installing Skills,
requesting connections, creating schedules and event triggers, choosing a
machine) and the chat simply continues as the bot.

Setup instructions can be exact ("install these Skills and create this
schedule") so the agent sets itself up without asking, or open-ended ("ask how
they handle on-call today and set up what fits") so the same template works for
people whose tools differ. Setup never bypasses anything: connections still need
a person's authorization and Skill installs follow the workspace's Skill
settings.

Templates are stored per workspace (`bot_templates`). Everyone in the workspace
can start a bot from one. Whoever saved a template, a workspace admin, or a
workspace-level (service) caller may change or delete it. Routes:

| Route | Needs |
| --- | --- |
| `GET /v1/workspaces/:workspaceId/bot-templates` and `/:templateId` | `sessions:read` |
| `POST /v1/workspaces/:workspaceId/bot-templates` | `sessions:create` |
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

### The agent suggesting a bot

When a person keeps asking a chat for the same kind of work, or says they will
want it again, the agent may call `bot_suggest` once in that chat (capability
`subagents`, needs `sessions:read`). It offers one of two things:

- `create`: make this chat a bot. The agent chooses the name, a one-line
  description and an avatar, and drafts setup instructions for a template.
- `reuse`: a bot chat (`sessionId`) or bot template (`templateId`) that already
  does this work. A `create` whose name a bot or template already has is
  declined with the existing ones listed, so the agent can suggest reusing one.

The tool changes nothing. It records the newest suggestion on the chat
(`sessions.bot_suggestion`, migration `1014_session_bot_suggestion.sql`, display
state that never reaches the model, returned as `Session.botSuggestion`) and the
chat shows it as a card. **Make it a bot** sets the chat's name, description
and avatar as the person and keeps it live; **Save as template…** opens the
template dialog filled in from the draft; a `reuse` card opens the bot chat or
starts a bot from the template; **Not now** hides it in that browser. A chat
that is already a bot is not offered one. One sentence of prompt guidance,
shown only while the tool can be available, tells the agent when to call it.
### Templates learn setup changes from their bots

A chat started from a template remembers it (`sessions.bot_template_id`,
migration `1015_bot_template_proposals.sql`, sent as `botTemplateId` when the
web app starts a bot; `Session.botTemplateId`). A chat saved as a template is
linked through the template's `sourceSessionId`.

Lessons that apply to every chat already reach every chat through workspace
Skills and Knowledge. What a template does not learn on its own is a bot's
**setup**: a Skill it installed, a connection or machine it added, a schedule
or event trigger it created, or a standing rule the person set for this bot.
When that changes, the agent may call `bot_template_propose_update`
(capability `subagents`, needs `sessions:read`) with the complete new setup
instructions (called with none, it returns the template's current ones). It
never changes the template: it stores a pending proposal
(`bot_template_proposals`, FORCE RLS plus the restrictive chat-visibility
policy, so a proposal from someone's Only me chat is visible only to them)
against the template as it was, and supersedes the same chat's earlier pending
one.

Whoever may change the template reviews a diff of the setup instructions, in
the chat or under **Proposed updates** on the Bot templates page, and accepts
or dismisses it. Accepting checks the template is still the version reviewed
(otherwise 409) and replaces its setup instructions; new bots started from it
then get the change, while bots already running keep their own chats.

| Route | Needs |
| --- | --- |
| `GET /v1/workspaces/:workspaceId/bot-template-proposals?templateId&sessionId&status` | `sessions:read` |
| `POST .../bot-template-proposals/:proposalId/accept` (`expectedUpdatedAt`) and `/dismiss` | `sessions:create`, and manage access to the template |

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

The file carries no ids, owner or image: an image avatar stays in its
workspace and is dropped on export.

## What is not here yet

- Plugins in setup instructions: a template can name Skills, connectors,
  schedules and machines today; installing a whole plugin from the agent is a
  follow-up.
- A bot's own identity in other channels such as Slack (posting under its name
  and avatar) is a follow-up.
