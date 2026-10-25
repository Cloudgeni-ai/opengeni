---
"@opengeni/core": patch
"@opengeni/api-router": patch
---

App actions in a chat driven by someone who uses Opengeni through another product (an external user, such as a person in an embedded chat) now work. Every call used to fail with 403 `invalid delegated human authorization`, because the person proof accepted only native accounts. These calls now run as that person in the chat's workspace only, with their live access there capped by the access frozen with their message, and no organization-level authority, so reads such as `getMyUsage` answer at once. Action search offers such a person only that workspace's actions. A call outside it is refused before anything runs, with a plain message that names the one workspace they can use. Refusals and 403 hints for them no longer point to Opengeni app pages. The exact-workspace person proof used by published Sites is now also exported as `stampWorkspacePersonAuthorization`, and it also covers an external person's own workspace.
