---
"@opengeni/db": patch
"@opengeni/api-router": patch
---

On the shared subscription core (still inactive for SuperGrok), a person whose SuperGrok account is personal now shows as connected in SuperGrok status. Only the signed-in owner (or an agent with their full access) gets a live check of it there. Before the owner's own private turn treats their personal account as still exhausted, its billing is re-checked; no other turn re-checks it.
