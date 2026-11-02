---
"@opengeni/react": minor
---

Agents in the app: the sidebar's **Agents** page replaces Bot templates and the Slack agents list (All / Yours, New agent, Import, banners for the move and repeated names), with a page per agent (Chat, its chats, Instructions, First message, Memory, who can use it, and Slack availability per installation through a host slot). The new-chat composer has an agent chip and `?agent=<id>` links (`?botTemplateId=` still works) that fill in the agent's First message and start the chat with `agentId`; agent chats show the agent beside the title with a source line, and the chat header's ⋯ menu has **Make this an agent**. Renames: the chat's Agent tab is Settings, Connected agents is Connected apps, and Automations runs tasks on a schedule. New modules under `app/components/agents/*`, `app/lib/agents`, `app/lib/agent-avatar` and `app/lib/session-agent`; `app/components/bots/*` and `app/lib/bot-templates` are removed.
