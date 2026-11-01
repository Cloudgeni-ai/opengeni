---
"@opengeni/api-router": minor
---

Atlassian now connects through Atlassian's recommended v2 MCP endpoint, which covers Jira, Confluence, Jira Service Management, Bitbucket, Loom and Compass.

- **Every tool listed.** The catalog uses `https://mcp.atlassian.com/v2/mcp?tools=all`, so each Atlassian tool keeps its own approval policy instead of going through shared discover and execute tools. That query string is the catalog's one reviewed exception to its no-query rule.
- **Existing connections keep working.** The earlier v1 endpoint stays in the catalog as "Atlassian (v1)". A v1 token can't call v2, so connecting Atlassian again creates a separate v2 connection.
- **Account identity.** v2 connections are identified by the Atlassian account id from `https://api.atlassian.com/me`, with the email and name as their label. The v1 identity check also accepts the shape v2's `atlassianUserInfo` returns, ready for Atlassian switching v1 connections to v2 tools on 1 March 2027.
