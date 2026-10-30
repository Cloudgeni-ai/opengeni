---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/api-router": minor
"@opengeni/worker-bundle": minor
"@opengeni/react": minor
"@opengeni/react-native": minor
---

Meetings name themselves. Nobody has to type a name: a meeting started without one is named after the event on its owner's connected Google or Outlook calendar at the time it started, or else, once its notes are written, from what was said (the built-in summary passes a short name to `meeting_notes_save` as the new `title`). A name someone types, at start or by renaming, always wins and is never replaced. Recordings carry `titleSource` (`person`, `calendar`, `conversation`, `app` or `default`; migration 1132 adds it, and existing recordings are `person`), and create requests may pass `titleSource: "app"` for a title the app only guessed, such as the desktop app's "Zoom meeting". The web and phone recorders no longer send a made-up date name, the recorder shows the calendar name once the server has it (`serverTitle` in the upload status), and the meeting page shows the new name when the notes arrive. Private, declined, cancelled and all-day events are never used, and the calendar lookup never holds up capture.
