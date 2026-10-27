---
"@opengeni/contracts": patch
"@opengeni/sdk": patch
"@opengeni/db": patch
"@opengeni/react": patch
---

The person's current answer to "How do you want to use Opengeni?" is kept on the server per organization (migration 1003). `GET /v1/organization-memberships` returns it as an optional `signupUseCase`, and the new `PUT /v1/auth/organization-onboarding/use-case` changes it for an organization the person belongs to. In the web app, going Back and choosing again updates it, and the new-chat suggestions follow the account to any browser; the first answer is still recorded as before.
