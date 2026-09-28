---
"@opengeni/core": major
"@opengeni/db": minor
"@opengeni/api-router": minor
---

A task started from Slack now starts from what the workspace offers every new session instead of the person's last website composer selection. Connectors follow the workspace default connector policy (including the person's own personal connections when that policy includes connected servers, still executable only through the frozen delegation snapshot), OpenGeni tools follow the workspace default selection, repositories are the workspace's GitHub App repositories the person can use (capped at 20), and the Sandbox Environment and its Variable Sets follow the workspace default. Only an explicitly chosen model carries over. Mentions, commands, DMs and shortcuts now always add the read-only Slack context tools, including when the workspace has its own default OpenGeni tool selection; reactions still do not.

The Slack acknowledgement adds one line naming what the task started with, for example `Using connectors: Gmail, Linear; repos: opengeni.` The line is frozen on the interaction when its session binds (rolling migration 0529 adds the nullable `slack_interactions.session_defaults_line`), so a repaired acknowledgement re-renders identical bytes. A Slack message that links a workspace or session on a different deployment under the same parent domain (for example staging versus production) now carries a model-context note, so the agent says the link is for the other deployment instead of reporting the session as not found.

Breaking: `@opengeni/core` removes `getActorNewSessionDefaults`. Use `getActorNewSessionModelChoice`, which returns only an explicitly chosen model policy. `@opengeni/db` adds `SlackInteraction.sessionDefaultsLine` and an optional `sessionDefaultsLine` input to `bindSlackInteractionSession`, written only by the bind that wins.
