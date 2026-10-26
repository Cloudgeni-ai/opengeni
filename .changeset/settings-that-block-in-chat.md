---
"@opengeni/runtime": patch
"@opengeni/api-router": patch
"@opengeni/contracts": patch
---

When a setting blocks what the person asked for, the agent now offers to change it in the chat instead of describing where the setting is. The modular system prompt's blocked-tool rule names `admin_action_call` (the change still waits for the person's confirmation in the chat) whenever that tool may be available. Tool approval actions (`getConnectorToolPermissions`, `updateConnectorToolPermissions` and the chat MCP server equivalents) gain plain-language descriptions, and their confirmation reads, for example, "Let send_message run without asking?" instead of "Update connector tool permissions in this workspace?". The `sites` Skill says a tool set to Ask can't run from a Site, so the agent offers to set it to Allow in the chat.
