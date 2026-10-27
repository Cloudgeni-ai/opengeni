---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/db": minor
"@opengeni/core": minor
---

Bot templates learn setup changes from their bots. A chat started from a template is linked to it (`botTemplateId`), and the new `bot_template_propose_update` tool lets a bot propose updated setup instructions when it installs a Skill, adds a connection, creates a schedule or is given a standing rule. Whoever may change the template reviews a diff in the chat or on the Bot templates page and accepts or dismisses it. New routes under `/bot-template-proposals`, SDK methods `listBotTemplateProposals`, `acceptBotTemplateProposal` and `dismissBotTemplateProposal`, and migration 1015.
