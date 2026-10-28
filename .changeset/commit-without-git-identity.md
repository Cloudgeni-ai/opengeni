---
"@opengeni/agent-host": patch
---

An agent can commit where nobody configured a Git identity. Commands in a managed sandbox run as a uid with no account entry, and a container connected as a machine usually has no `user.email` and a hostname Git cannot turn into an address, so `git commit` failed with "Author identity unknown" and agents stopped to ask the person for a name and email. The sandbox and desktop images now set `Opengeni Agent <agent@opengeni.invalid>` at Git's system level, and the Connected Machine agent gives its commands `EMAIL=agent@opengeni.invalid` when its own environment has no `EMAIL`. Both are Git's lowest-precedence sources, so an identity the deployment, the person or the repository configured still wins.
