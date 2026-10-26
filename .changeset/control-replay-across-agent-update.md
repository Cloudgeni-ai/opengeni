---
"@opengeni/runtime": patch
---

Calls to a Connected Machine right after its agent updates itself no longer fail with an unknown outcome. Opengeni prefetches single-use delivery tokens from the agent, and the updated agent did not know the tokens its predecessor issued, so the first calls after every self-update (a file read, `view_image`, a command) were refused as "control delivery receipt expired" until fresh tokens arrived. The agent now hands its unused tokens to the updated image, which answers the same subject; a token the old image already admitted stays refused, so each delivery still runs at most once. Takes effect from the second self-update after the next agent release. Independently, a read-only operation whose token is refused (also after a crash or restart) is read again once with a fresh token; mutations still report their unknown outcome.
