---
"@opengeni/db": patch
"@opengeni/react": patch
---

An attached Chrome profile id now resolves only to copies announced by the same computer. A profile id is announced by the machine and stored per workspace, so a machine someone else enrolled in a shared workspace could announce the id of your Only me profile and, in that workspace, take its place in your list and receive your new browser and computer sessions. Copies now collapse only when their enrollments share the machine's key, your own personal enrollment is preferred over any shared one, and an id announced by different shared machines is refused unless a session pins its workspace, with each machine's copy listed.
