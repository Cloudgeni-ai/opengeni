---
"@opengeni/react": patch
---

**Add trigger** and a suggested trigger's **Set up** on an agent's page now open a small dialog instead of the full New automation form. Pick what starts the agent: a schedule, one of your event sources, or any kind of source you can still add, each with its logo. GitHub, Slack and This workspace are added right there, a webhook is created right there and shows its URL, and if GitHub isn't connected yet the one button is **Connect GitHub**. The note is optional: each run gets the event and the agent's Instructions do the rest, in a new chat with the agent. A trigger is shared with the workspace unless the agent is Only me, and the dialog says so when you can't add a shared one. **Open full form** still opens every setting, and now comes back to the agent's page on Cancel and Save.
