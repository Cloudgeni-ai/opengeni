---
"@opengeni/core": patch
"@opengeni/react": patch
---

The Agents page lists the ready-made agents not added yet under the workspace's own, each added in one click. The Artifacts page's Apps tab, and its empty state, offer ready-made apps the same way, opening the app once it's added. Three new ready-made apps keep their own data: **Issue tracker**, **Incident log** and **Feedback board** (with votes), next to **Decision log**.

A GitHub trigger now covers every repository the GitHub connection reaches, or only the repositories you choose, and each run checks out the repository its event is about. Before, the one repository picked in **Add trigger** was only checked out, so the trigger fired for every repository; existing triggers now fire only for that repository.

The pasted webhook secret steps are one component shared by Add a source, a source's page and Add trigger, and the Skills section on an agent's page has more room above **Add a Skill**.
