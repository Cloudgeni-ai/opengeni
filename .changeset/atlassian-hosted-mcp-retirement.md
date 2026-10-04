---
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/config": patch
"@opengeni/runtime": patch
---

Use hosted Atlassian MCP for Jira and Confluence agent access. Retire native API tools and Knowledge sync admission while preserving historical wire types, encrypted grants, imported Documents and cleanup paths. Existing native schedules no longer fetch provider content; pending authorization attempts settle without exchanging a native grant. Google Drive integration is unchanged.
