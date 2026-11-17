---
"@opengeni/api-router": patch
---

`github_repository_attach` no longer refuses a repository that has commits as "empty". It decided emptiness from GitHub's repository `size`, which GitHub computes lazily and can report as 0 long after the first push, so a freshly pushed repository could not be attached for a long time. A repository now counts as empty only when GitHub lists no branch for it; when the branch list cannot be read, the repository is attached as before. Slack tasks likewise no longer skip a repository from the person's new-chat form because GitHub reports its size as 0; an empty one is kept, as a new chat in the app keeps it, and the sandbox starts it on an unborn branch.
