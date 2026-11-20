---
"@opengeni/api-router": patch
---

The Slack "Who should answer in #channel?" picker is now one menu with an Agents group and a Workspaces group, with "Not now" beside it. Agents show their avatar emoji, and workspaces show their plain names instead of "Opengeni in …". A choice in a Slack menu (`static_select`) is read from its selected option. In Opengeni, the Slack channels routing menu groups agents and workspaces the same way, and a closed menu says whether the chosen name is an agent or a workspace.
