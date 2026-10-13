---
"@opengeni/db": minor
"@opengeni/core": minor
"@opengeni/api-router": patch
---

An Only-me session can now share a sandbox or Connected Machine with other sessions. Who can read a conversation and who can use a box are separate: making a session private, or creating one private, no longer requires its own sandbox group, and its conversation, events, command records, terminals and stream access stay scoped to its audience while files on the box stay as shared as the box. Migration 0739 (rolling) drops the singleton-group requirement from visibility transitions and whole-session forks, counts only sandbox access attributed to the session itself as a quiescence blocker, and lets a top-level private create join a group its creator can already see. Effective control now walks the complete ancestry, so a paused private parent still pauses its workspace-visible children, shown to other members only as "An ancestor session". Variable Set changes still require a singleton group, now counted across every member including private ones, and the stream-capabilities shared-exposure flag counts every session on the box while listing only the ids the caller can read.
