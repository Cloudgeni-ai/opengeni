---
"@opengeni/api-router": patch
"opengeni-web": patch
---

A provider that refuses a connection now says so, instead of "This connection link is no longer valid or was already used". Some providers redirect a refusal back with only an error and no state; Fiken does when the signed-in Fiken user is not approved for the app. Every OAuth callback (Fiken, curated provider OAuth, MCP, social, personal GitHub and the Slack bot install) treated the missing state as a stale link. They now report the provider's refusal (cancelled for `access_denied`, refused otherwise), and Fiken says the Fiken user may not be approved for the app yet.
