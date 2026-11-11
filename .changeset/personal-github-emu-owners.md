---
"@opengeni/api-router": patch
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/runtime": patch
---

Your GitHub accepts repository owners whose logins contain an underscore, as enterprise managed users' do (`octocat_acme`). Choosing, searching, attaching and using such repositories now works everywhere personal GitHub checks an owner: the repository chooser and its stored selection (migration 1361 widens the database check, 1362 validates it), agent-created workers and schedules, the `gh` gateway, the account repository tools and the repository identity shown to the agent. Owners still need 1 to 39 letters, digits, `-` or `_`, starting with a letter or digit. The documentation also states that a schedule an agent saves with Your GitHub repositories runs as the person only while their login stays turned on in the workspace, since a login is never turned on for a single message or chat.
