---
"@opengeni/core": patch
"@opengeni/api-router": patch
"@opengeni/db": patch
"@opengeni/contracts": patch
---

App actions in a chat driven by someone who uses Opengeni through another product (an external user, such as a person in an embedded chat) now work. Every call used to fail with 403 `invalid delegated human authorization`, because the person proof accepted only native accounts. These calls now run as that person in the chat's workspace only, with their live access there capped by the access frozen with their message, and no organization-level authority, so reads such as `getMyUsage` answer at once. Action search offers such a person only actions that can succeed for them: that workspace's actions, only reads unless their message allows changes, nothing that carries a secret, and only actions whose first access check their access passes (each catalog entry now records that permission as `permission` when its handler shows one). With full access, such a person can do everything they can in that one workspace, and every path (search, a call, a session tool reaching another workspace) gives the same answer. A call outside that workspace is refused before anything runs, with a plain message that names the one workspace they can use. Refusals and 403 hints for them no longer point to Opengeni app pages. The exact-workspace person proof used by published Sites is now also exported as `stampWorkspacePersonAuthorization`, and it also covers an external person's own workspace, as their active organization membership names it (`externalPersonPersonalWorkspaceId`).
