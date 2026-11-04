---
"@opengeni/react": minor
"@opengeni/sdk": patch
"@opengeni/db": patch
---

Agents in the app: the sidebar's **Agents** page replaces Bot templates and the Slack agents list (All / Yours, New agent, Import, banners for the move and repeated names), with a page per agent (Chat, Export, its chats, Instructions, First message, Memory, who can use it, and Slack availability per installation through a host slot). The new-chat composer has an agent chip and `?agent=<id>` links (`?botTemplateId=` still works) that fill in the agent's First message and start the chat with `agentId`. Send waits while the agent loads and never starts an ordinary chat in its place; an agent that can't be used here shows why on the chip. An untouched First message stays out of the saved draft, so it never reaches another tab or device without its agent. An Only me agent makes the chat Only me while it is chosen. Agent chats show the agent beside the title with a source line, and the chat header's ⋯ menu has **Make this an agent** (prefilled with the chat's name, icon, description and instructions). **Export** saves an agent as an `.agent.json` file with its Instructions, First message, Memory switch and who can use it; Import reads it (an Only me agent stays Only me where Only me chats are available) and older `.bot.json` files. Renames: the chat's Agent tab is Settings, Connected agents is Connected apps, and Automations runs tasks on a schedule.

For embedding apps: `SessionHeader`'s `onSaveBotTemplate` is now `onMakeAgent`; the create option `bot` (`NewSessionBotProfile`: name, description, avatar) is now `agent` (`NewSessionAgent`: the agent's `id` and the `avatar` the chat shows); `NewSessionBotProfile` is removed. New modules under `app/components/agents/*`, `app/lib/agents`, `app/lib/composer-agent`, `app/lib/agent-avatar` and `app/lib/session-agent`; `app/components/bots/*` and `app/lib/bot-templates` are removed.

`CreateSessionRequest` in the SDK now types `agentId`. The archive refusal for Keep this chat active points to the chat's Settings tab.
