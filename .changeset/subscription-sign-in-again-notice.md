---
"@opengeni/contracts": patch
"@opengeni/sdk": patch
"@opengeni/db": patch
"@opengeni/react": patch
"@opengeni/react-native": patch
"@opengeni/desktop": patch
---

When a Claude, ChatGPT or SuperGrok subscription account stops accepting its sign-in, the person who connected it now gets one inbox notice and phone notification, for example "Sign in to Claude again", with the account's email. If that person can no longer manage the account, the organization's owners and admins get it instead. The notice's "Sign in again" opens that account's own sign-in step. For Claude, the step names the email to sign in as, and the person signs in with Claude and pastes the code. The notice goes away once the account works again, and a later lapse gets a new notice.

Each account's page shows how long ago it was signed in. A Claude account signed in 25 or more days ago shows a warning with "Sign in again" before Claude stops accepting the sign-in, which tends to happen around 28 to 30 days.

`GET /v1/inbox` returns these notices in a new optional `notices` list (`InboxNotice`: shaped like a notification item, with `sessionId: null` and always a `link`). `items`, `needsYouCount` and `unreadCount` are unchanged. Subscription account listings carry an optional `signedInAt`. A phone notification about something other than a chat carries the address to open in `url`.
