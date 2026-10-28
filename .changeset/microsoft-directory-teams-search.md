---
"@opengeni/capabilities": minor
"@opengeni/core": patch
---

Agents can look up colleagues with a work or school Microsoft 365 account: SharePoint and Teams can search the organization directory and read a colleague's profile, manager and direct reports, and Outlook Contacts can read the signed-in person's own manager and direct reports. SharePoint requests basic profiles (User.ReadBasic.All, no administrator consent); Teams requests User.Read.All for job title and department. Teams can also search chat and channel messages with Microsoft Search, limited to Teams messages, without asking for approval. Existing Teams connections need to reconnect, with administrator consent, to use the new tools.
