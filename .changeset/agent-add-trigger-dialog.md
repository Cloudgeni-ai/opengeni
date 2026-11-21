---
"@opengeni/react": patch
---

**Add trigger** and a suggested trigger's **Set up** on an agent's page now open a small dialog instead of the full New automation form. Pick an event or a schedule; a suggestion arrives filled in and asks only for its source (and, for GitHub, an optional repository). The message is optional. A trigger is shared with the workspace unless the agent is Only me, and the dialog says so when you can't add a shared one. When the source it needs isn't connected yet, the dialog's one button adds it. **Open full form** still opens every setting.
