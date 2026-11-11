---
"@opengeni/api-router": patch
"@opengeni/core": patch
---

Agents can start workers that act as the person on GitHub. A session or scheduled task an agent creates from its own turn may name a personal repository with just `uri`, `ref` and `connectionType: "github_personal"`; the server fills in the provider, credential binding, repository ID and access from the calling turn's Your GitHub delegation, capped at what that turn holds, in both chosen-list and All my repositories mode. A partly specified resource (for example one copied without `access`) is completed the same way, and any binding or repository ID it carries must match. A repository outside the delegation, more access than the turn holds, a repository removed from the chat, or a turn without Your GitHub access is refused with a message saying why and what fixes it. A child may also check out another ref of a repository its parent holds as the person.

`github_connect_link` reports `personal.allRepositories` (`{ enabled, access }`) next to `repositoryCount`, so agents know the person allowed all their repositories and no longer ask them to pick repositories. Its description and the Your GitHub identity guidance mention the mode only where the deployment offers it.
