---
"@opengeni/db": patch
---

Opening an organization invitation no longer locks the invitee out. Signing in links pending invitations to the verified account. The organization seat-limit check used to depend on the signed-in person's own organization context. As a result, people with an existing account were denied access to every organization, and in restricted database setups the seat limit could be skipped. The check now always evaluates the inviting organization and leaves the caller's context unchanged.
