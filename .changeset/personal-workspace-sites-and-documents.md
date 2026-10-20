---
"@opengeni/db": patch
"@opengeni/api": patch
"@opengeni/web": patch
---

Sites and documents work in Personal workspaces. The owner can now create, open and edit documents, spreadsheets and presentations there; they used to be refused because a Personal workspace has no membership row. Publishing an Only me Site from a Personal workspace (every Site an agent makes there) now shares it with that one-person workspace as it publishes, instead of stopping at a "Share this Site with the workspace first" notice with no way to share. On their published Site the owner is a member again: they can open members-only and invited Sites, and their Site AI chats run as themselves rather than as an outside visitor.

Workspace Viewers can use a Site's assistant wherever people outside the workspace can (invited or anyone-with-the-link Sites), as an outside visitor would; they used to get "missing permission: sessions:create" while anonymous guests could chat. On members-only Sites the page is now told the assistant is unavailable to them instead of offering it.
