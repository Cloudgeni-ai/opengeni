---
"@opengeni/db": patch
---

Seat limits no longer refuse writes that take no new seat. Signing in with a pending invitation to an organization that is over its seat limit (after a downgrade or a lower plan limit) binds the invitation instead of failing the sign-in and locking the person out of every organization, and repeated membership-anchor inserts for an existing member are no longer counted. New invitations and new members are still refused over the limit, and the refusal's details now include the organization's `planKey`. Sign-in binding now handles each organization separately: if one organization's binding fails for any reason, its invitations stay pending for the next sign-in, a WARNING "organization invitation binding skipped" is logged, and the person keeps their other organizations.
