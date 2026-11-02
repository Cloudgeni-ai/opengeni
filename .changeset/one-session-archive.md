---
"@opengeni/react": minor
"@opengeni/sdk": minor
"@opengeni/contracts": patch
"@opengeni/api-router": minor
---

A chat has one kind of archive. Archive now archives the chat for everyone, the same long-term storage the idle-session archive uses, instead of hiding it from one person's list. It needs session control. The chat leaves every list at once and the notice offers Undo for ten seconds; after that the chat's goals pause, its running work stops, its one-time automations are removed, and it is stored read-only for good. An archived chat stays readable, searchable and linkable, is listed on the Archived page (formerly Read-only chats, whose old path redirects), and offers "Continue in a new chat". Archive is refused with a plain reason while keep-live, a repeating automation or a site sign-in keeps the chat live.

"Hide for me", Restore and the pause confirmation are gone. `PUT …/sessions/:id/archive` accepts `{ archived: true }`, and `{ archived: false }` only within the Undo window (409 `session_archive_final` after it); `mode`, `confirmPause`, `expectedVersion` and `clientEventId` are accepted and ignored. Refusals are 409 `session_archive_blocked` with `blockers`. `SessionList`'s Archive button (`archive` prop) does the same and shows its own Undo line. Chats people had hidden with the old personal archive are archived for real by the migration, unless something keeps them live; those come back to the list.
