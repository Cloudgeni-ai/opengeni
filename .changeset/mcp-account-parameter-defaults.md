---
"@opengeni/runtime": patch
---

Connected MCP tools that require an identifier the account already fixes, such as Atlassian's `cloudId`, now fill it in from the connected account. Models no longer have to find the lookup tool first, or guess a value. Tools list the parameter as optional, with a generic note. A call that leaves it unset (missing, empty, or a phrase such as "list accessible resources") gets the account's only value. If the account has several, the call isn't sent and returns a recoverable error listing each name and id to choose from; a phrase matching one of the names picks it. Any other supplied value is never replaced, and a failed lookup sends the call on unchanged. Each server contributes only declarative data keyed by its exact MCP URL; Atlassian's v1 and v2 endpoints are the first.
