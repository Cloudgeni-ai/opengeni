---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

A chat with a repository attached now answers without first waiting for its sandbox.

Indexing the repository's skills used to be the first workspace operation. On a lazily provisioned managed box, the first model request therefore waited for the box to start, the custom environment setup to run and the repository to clone, even when the turn needed no tool. On staging this took over a minute and a half for a one-word prompt.

- **Deferred index:** these sessions now leave the repository skills index out of the instructions. Instead, they tell the model which skill folders to check and how to name a skill for `repository_skill_read`.
- **Workspace preparation:** the workspace is still prepared when a sandbox tool first uses it, exactly as before, and the box create still starts early.
- **Stable instructions:** the choice holds for the whole session, so the instructions stay the same from turn to turn. Sessions on Connected Machines, or with lazy provisioning off, keep the live index.
- **Better errors:** a `repository_skill_read` call with an unknown identifier now lists the identifiers that exist.
- **Accurate startup metrics:** repository skill discovery that starts after the first model request is no longer counted as model-preparation startup.
- **API:** `buildAgent` accepts `deferRepositorySkillIndex`, and `workspaceSkills` accepts `{ deferred: true }`. A deferred index never touches the sandbox session.
