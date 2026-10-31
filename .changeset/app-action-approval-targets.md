---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/react": minor
---

Approval cards for app actions name what they change. The server reads each id the action takes, as the person the chat acts for, and the question names the target in its own words, for example "Remove the Gmail connection for anna@example.com?", with a few facts beneath it (who can use it, when it was added). Arguments the agent wrote never write the question or the facts; in Details they sit under "Sent by the agent". A target the person can't see, or one that can't be read, keeps the plain wording. Answered approvals say what was decided for each action, one line each in a batch, instead of "You responded to this approval." Slack's private review shows the same question and facts. `@opengeni/db/app-action-targets` is a new subpath.
