---
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
---

A chat whose automatically attached GitHub repository later loses access (the GitHub App is uninstalled, or the repository is taken out of it) no longer refuses every follow-up. Follow-ups used to re-check all of the chat's repositories and answer 422 "The request could not be accepted. Check your input and try again." for good, so Retry could never succeed. Now those optional repositories are left to the worker, which drops them for the turn and reports them as skipped. Repositories a message adds, and ones attached explicitly, are still checked. That refusal now carries `details.code: "github_repository_unavailable"` and the repository names, and the composer says which repository to remove or restore. Any other 400/422 Send refusal that has a server reason shows that reason instead of the generic "check your input". The SDK keeps short string lists in error `details`, for example `repositories` and `allowedLatencyModes`.
