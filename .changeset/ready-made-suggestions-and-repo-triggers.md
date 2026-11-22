---
"@opengeni/core": patch
"@opengeni/react": patch
"@opengeni/runtime": patch
---

The Agents page lists the ready-made agents not added yet under the workspace's own, each added in one click. The Artifacts page's Apps tab, and its empty state, offer ready-made apps the same way, opening the app once it's added (Capabilities' **Ready-made** tab now opens it too). Three new ready-made apps keep their own data: **Issue tracker**, **Incident log** and **Feedback board** (with votes), next to **Decision log**.

An agent's GitHub trigger now covers every repository the GitHub connection reaches, or only the repositories you choose, and each run checks out the repository its event is about. Before, the one repository picked in **Add trigger** was only checked out, so the trigger fired for every repository; existing agent triggers now fire only for that repository. An agent's GitHub trigger saved with no repository, which already fired for every repository, now also checks out each event's repository (from the workspace's GitHub allowlist) in its new chat. A trigger that continues a chat keeps the chosen repositories open there. Other automations are unchanged.

The pasted webhook secret steps are one component shared by Add a source, a source's page and Add trigger, and the Skills section on an agent's page has more room above **Add a Skill**.

New apps take the Opengeni look by default (`/__opengeni/ui.css`), single-file apps included, unless the person's design, the workspace's design system or the product the app is about comes first; the ready-made apps use it too.
