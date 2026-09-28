---
"@opengeni/core": major
"@opengeni/db": minor
"@opengeni/api-router": minor
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/github": minor
"@opengeni/runtime": minor
---

A task started from Slack now starts from what the workspace offers every new session instead of the person's last website composer selection. Connectors follow the workspace default connector policy (including the person's own personal connections when that policy includes connected servers, still executable only through the frozen delegation snapshot), OpenGeni tools follow the workspace default selection, and the Sandbox Environment and its Variable Sets follow the workspace default. Only an explicitly chosen model carries over. Mentions, commands, DMs and shortcuts now always add the read-only Slack context tools, including when the workspace has its own default OpenGeni tool selection; reactions still do not.

Repositories are the person's own recently used repositories in that workspace: those on the top-level sessions they started there in the last 30 days, most recent first, at most five, and only through their current entry in the workspace GitHub App catalog (same catalog and `github:use` permission as the website picker), on the default branch. Archived and empty repositories are skipped. A person with no recent repositories gets none; GitHub is asked only when there is something to look up, and an outage starts the task without repositories. These repositories are attached best effort.

Repository resources gain an optional `optional: true` flag (contracts and SDK). A failed clone of such a repository logs a warning, is reported as `skippedOptionalRepositories` on the `repository-clone` operation event, and no longer fails sandbox setup; a repository without the flag keeps the strict behavior. `GitHubRepository` gains optional `archived` and `sizeKb`, filled from GitHub when reported.

The Slack acknowledgement adds one line naming what the task started with, for example `Using connectors: Gmail, Linear; repos: opengeni.` It names only connectors the first accepted turn can reach, so a personal-only connector the person never connected is not claimed. The line is frozen on the interaction when its session binds (rolling migration 0529 adds the nullable `slack_interactions.session_defaults_line`), so a repaired acknowledgement re-renders identical bytes. A Slack message or a reacted-to message that links a workspace or session on a different deployment under the same parent domain (for example staging versus production) now carries a model-context note, so the agent says the link is for the other deployment instead of reporting the session as not found.

Breaking: `@opengeni/core` removes `getActorNewSessionDefaults`. Use `getActorNewSessionModelChoice`, which returns only an explicitly chosen model policy. `@opengeni/db` adds `SlackInteraction.sessionDefaultsLine`, an optional `sessionDefaultsLine` input to `bindSlackInteractionSession` (written only by the bind that wins), `listRecentSessionRepositoryResources`, and `getSessionFirstTurnConnectionAuthority`.
