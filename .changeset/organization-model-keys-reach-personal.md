---
"@opengeni/db": patch
"@opengeni/api-router": patch
---

Organization model API keys (Vercel AI Gateway, OpenRouter, Opper, OpenAI, Azure OpenAI, Anthropic, and ElevenLabs for voice) now reach Personal workspaces like the organization's subscriptions do. A key available in every workspace serves everyone's Personal workspace too, and "Only selected workspaces" has the same Personal workspaces switch; the model access response reports `personalWorkspacesSupported: true` for every organization connection. Keys never reach another organization's workspaces, and each workspace's Allowed models still apply. Rolling migration `1094_organization_model_keys_reach_personal.sql` widens the organization provider scope to Personal workspaces of the same organization and keeps the previous reach of keys limited to selected workspaces (their Personal switch is stored off).

Billing note: when the organization's default model runs on an organization key, Personal chats and schedules with no saved default model of their own now use it too, so they bill that organization provider account instead of credits or a subscription.
