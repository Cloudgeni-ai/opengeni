---
"@opengeni/capabilities": minor
"@opengeni/core": patch
---

Agents can look up colleagues with a work or school Microsoft 365 account: SharePoint and Teams can search the organization directory and read a colleague's profile and direct reports. SharePoint requests basic profiles (User.ReadBasic.All, no administrator consent). Teams requests User.Read.All, which adds job title, department and manager lookups. Teams can also search chat and channel messages with Microsoft Search, limited to Teams messages, without asking for approval. Existing Teams connections need to reconnect, with administrator consent, to use the new tools.
