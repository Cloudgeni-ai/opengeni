---
"@opengeni/api-router": patch
---

An agent acting as a person with their full access (session admin access, or a connected agent with Full access over all workspaces) can now change who can use a connected machine, Workspace or Only me, through the `previewMachineAudience` and `changeMachineAudience` admin actions, exactly as the person can on the Machines page. An agent acting as itself, or one with less than the person's full access, is still refused.
