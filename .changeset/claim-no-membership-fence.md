---
"@opengeni/db": patch
---

Turn claims no longer wait on organization membership changes. The claim takes no organization-membership lock at all, so a member being added, suspended or removed never delays turns starting in that organization; a removal that races a claim is still refused when the turn acts.
