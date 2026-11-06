---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

A chat with a repository attached answers without first waiting for its sandbox. Indexing the repository's skills was the first workspace operation, so on a lazily provisioned managed box the first model request waited for the box to start, the custom environment setup to run and the repository to clone, even when the turn needed no tool (over a minute and a half on staging for a one-word prompt). Such turns now leave the repository skills index out of the instructions and tell the model which skill folders to check; the workspace is prepared when a sandbox tool first uses it, exactly as before, and the box create still starts early. Connected Machines and eagerly established boxes keep the live index. `buildAgent` accepts `deferRepositorySkillIndex`, and `workspaceSkills` accepts `{ deferred: true }`; a deferred index never touches the sandbox session.
