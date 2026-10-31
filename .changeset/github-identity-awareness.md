---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/runtime": minor
"@opengeni/react": minor
"@opengeni/api-router": minor
"@opengeni/worker-bundle": minor
---

The agent knows both GitHub identities, and the GitHub sheet names them. `github_connect_link` adds a `personal` field for the person's own account ("Your GitHub"): `{ enabled, connected, status, login, repositoryCount, connectUrl, manageUrl }`, with links only for `connections:write` and no token; the App fields are unchanged. `capability_catalog_search` offers a new `api:github-personal` capability ("Your GitHub") when personal OAuth is enabled, and `capability_authorization_request` posts its in-chat card (connect, then choose repos). Agent guidance maps "connect my GitHub" or "do it as me" to Your GitHub and "install the GitHub app" to the Opengeni app. The repositories prompt lists each mounted GitHub repository's identity (as the person, with their login, or as the Opengeni app) and says that `gh` and raw API calls do not act as the person. The GitHub sheet shows two sections, "Your GitHub" and "Opengeni app", each with one action; the header's "Connect another account" is gone, and the repository chooser opens right after connecting. New exports: `PERSONAL_GITHUB_CAPABILITY_ID`, `PERSONAL_GITHUB_SETUP_QUERY_VALUE` and `personalGitHubSetupPath` in `@opengeni/contracts/personal-github`; `AgentPromptRepositoryIdentity`, `repositoryIdentitiesFor` and the `personalGitHubLogin` build option in `@opengeni/runtime`; and `IntegrationSection` with `IntegrationViewModel.sections` in `@opengeni/react`.
