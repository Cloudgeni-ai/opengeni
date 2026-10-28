---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/db": minor
"@opengeni/core": minor
---

Bots, finished. Bot templates now have a visibility: `workspace` (everyone who can open the workspace) or `private` (only the person who saved it). The template dialog has a "Who can use it" choice and private templates show an "Only me" chip. When an agent in an Only me chat saves itself with `bot_template_save`, the template is private; a run with no person behind it cannot save from an Only me chat. A `sourceSessionId` sent to `POST /bot-templates` must be a chat in the same workspace that the caller can open.

Marketplace plugins are listed in the integration catalogue (`kind: "plugin"`), so an agent can find one with `capability_catalog_search` and offer it through the same in-chat card it uses for connectors. The card shows the agent's reason, who made the plugin and what it adds, and the person reviews and installs it from there. Someone without permission to manage the workspace's plugins sees that a workspace admin has to install it, and the agent is told the same. `PluginDetails` takes `showIdentity={false}` for hosts that already show the plugin's name and logo.

In Slack, a bot chat with an avatar can post its replies under its own name and avatar. This uses the optional `chat:write.customize` scope, so a Slack admin must reinstall the app to grant it; without it, posts stay under the app's name. The avatar image comes from a new signed public route, `GET /v1/public/session-avatars/{token}.png`. The API image now includes an emoji font so emoji avatars render in that image.
