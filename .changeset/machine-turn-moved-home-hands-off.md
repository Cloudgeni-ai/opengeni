---
"@opengeni/worker-bundle": patch
"@opengeni/runtime": patch
---

A turn working on a Connected Machine no longer keeps sending commands to that machine after the chat is moved to its own managed box mid-turn. Every later tool call used to fail with a raw database query error, because the machine's per-operation authority (correctly) refuses a machine that is no longer the chat's active sandbox. The turn now hands off typed to the chat's managed box and continues there in a fresh attempt, as chats that started on a managed box already did. When a Connected Machine authority check is refused, the worker now logs the database's SQLSTATE, its raised reason and the refusing function, so the next such failure is diagnosable from logs. The tool result text the model sees is unchanged.
