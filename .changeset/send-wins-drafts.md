---
"@opengeni/api-router": patch
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/react": patch
"@opengeni/sdk": patch
---

Send always wins over the saved draft. Starting a new chat or sending in an existing chat now carries exactly what is in the box and is never refused because the draft changed, on web, the Mac app and mobile; retries stay safe through the message's client event ID.

API change: `expectedNewSessionDraftRevision` on create and `expectedDraftRevision` on composer submit no longer make the server refuse a Send with `NEW_SESSION_DRAFT_CONFLICT` or `DRAFT_CHANGED`. They are now the revision the sender last saw, the basis for clearing the draft: after an accepted Send the server clears the draft only while it is still at that revision or holds exactly what was sent. Otherwise a newer draft typed on another device stays (composer submit returns it as `draft`) and the composer shows it. Composer submit now also accepts `expectedDraftRevision: 0`, meaning the sender saw no saved draft. Draft saves keep their revision checks.

A person's other devices now follow their latest draft live through a private, content-free hint on the workspace live stream (`workspace.drafts.changed`), and typing over another device's edit saves on top of it instead of asking which draft to keep. Mobile new chats now clear the saved draft they were sent from. Against a server from before this change, a mobile new chat that the server refuses over its draft is retried once without the draft, as such servers always accepted.
