---
"@opengeni/runtime": patch
---

`tool_search` now offers the Connect card for an integration the query names even when an unrelated installed tool matches strongly, such as a Slack bot tool for "posts on Slack" or meeting search for "Linear issues". The integration catalog lookup is skipped only when a strong match is that integration's own tool. Integration names are also recognised with different spacing or case ("hub spot", "wisprflow"), as small near misses of names of eight or more letters ("whisperflow" for Wispr Flow), and by the vendor's word in its domain ("jira" for Atlassian at jira.com). Common words close to a name ("email" for Gmail, "conference" for Confluence, "grammar" for Grammarly) never name it. The lookup reads the catalog's top ten matches instead of three, with the same 2-second bound.
