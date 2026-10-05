---
"@opengeni/db": patch
"@opengeni/core": patch
---

Session create and read issue far fewer database round trips. Each RLS transaction writes its tenant, protocol, and actor settings plus the shared session-tenancy fence in one statement and verifies them with one independent read-back, and workspace-scoped transactions resolve the owning account in that same statement instead of a separate lookup. A create that names no model admits the resolved default from the selection input it was chosen from instead of loading the catalog again, and connection model restrictions read their independent provider families concurrently.
