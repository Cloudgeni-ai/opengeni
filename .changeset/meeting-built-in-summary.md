---
"@opengeni/contracts": minor
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
"@opengeni/api-router": patch
"@opengeni/sdk": patch
"@opengeni/react": minor
---

Meetings get their notes written automatically. When a meeting's transcript is ready, Opengeni starts one chat for the meeting's owner (Only me for an Only me meeting, a workspace chat for a shared one) that writes the notes: an overview, topics, decisions and action items, with speakers and people linked as `speaker:` and `person:` mentions. The chat can only read that one meeting and save its notes, and nobody can widen it later. It runs on the workspace's shared Codex or Claude subscription accounts like other background work, and doesn't start when no subscription account can serve it, so it never spends credits or an API key. It never writes over saved notes and steps aside when the owner has their own automation for ready transcripts. Admins can turn it off with "Write notes after each meeting" in the meeting settings (`settings.recordings.autoSummary: false`). `meeting_read` now gives each speaker's label, and the "Meeting notes" template asks for the same format.
