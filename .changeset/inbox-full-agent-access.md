---
"@opengeni/sdk": minor
"@opengeni/contracts": minor
"@opengeni/db": minor
---

People can give agents full access to their inbox. A third choice under "What agents can do here" on the Inbox page (and in the app's Settings) lets any agent working for the person see every open item (questions, approvals, paused goals, replies and notifications, needs-you first, with their session) and snooze, unsnooze or dismiss any of them through `inbox_tidy`, so they can ask an agent to catch them up and clear what's done. Agents still never answer a question or decide an approval for the person; dismissing one only clears it from the inbox. The other two choices keep their behavior. SDK: `InboxTidyPolicy` gains `"full_access"`.
