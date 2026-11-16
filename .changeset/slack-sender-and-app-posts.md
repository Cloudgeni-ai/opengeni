---
"@opengeni/api-router": patch
"@opengeni/runtime": patch
---

Opengeni now says correctly who sent a Slack message. A message sent with your own Slack account is posted under your name, but Slack also marks the Opengeni app it went through, so Opengeni sometimes said the bot had sent it. The send result now says which account a message was posted as (`postedAs`: your own account, naming the app only as the route it went through, or the Opengeni Slack bot). Channel and thread reads with your own account mark your own messages with `postedByYou`.

When you mention Opengeni, it now sees messages that apps and bots posted. The surrounding channel or thread messages, and the `slack_bot_*` history reads, name the app that posted each message and include text an app put in attachments or blocks. Replies that apps post in a thread, and posts people send through an app, are kept as context for the next mention in that thread. They never start or stop a task, and Opengeni's own posts are still left out.
