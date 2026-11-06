---
"@opengeni/api-router": patch
---

The Microsoft Teams app package now names its publisher as `Opengeni` with Opengeni's Microsoft partner ID by default, both configurable (`OPENGENI_TEAMS_DEVELOPER_NAME`, `OPENGENI_TEAMS_MPN_ID`, or `none` to leave the ID out). Its short and full descriptions name Microsoft Teams, say that replies are AI-generated and can be wrong, and state the one-time administrator setup, the Opengeni account requirement with the website as the way to sign up, and the main limitations. The bot declares Teams commands: `help`, `link`, `unlink` and three prompt starters in personal chats, and `help` in enabled group chats.
