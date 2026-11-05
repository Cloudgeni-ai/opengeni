---
"@opengeni/api-router": patch
"@opengeni/db": patch
---

The Microsoft Teams bot now has a first-run, help and AI experience. Adding it in personal scope sends one welcome that says what Opengeni does, that replies are AI-generated, that an Opengeni account is needed, its main limitations and how to get help. `help` is answered with fixed text in Teams, for linked and unlinked people, without starting agent work, and `unlink` (with a confirmation button) removes your Teams link from inside Teams. Teams shows a typing indicator while a reply is being produced. Replies are sent as Markdown, with tables, deep headings, images and rules rewritten into what Teams text messages can show. Agent replies carry Teams' AI generated label and thumbs up/down feedback buttons, and feedback is recorded as ordinary Opengeni feedback on the chat and turn.
