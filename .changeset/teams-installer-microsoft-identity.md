---
"@opengeni/api-router": minor
"@opengeni/sdk": minor
---

An operator-approved Teams installer (`OPENGENI_TEAMS_BOT_SETUP_ADMIN_IDS`) now signs in to Microsoft before setup connects their organization, because setup also links their Teams account. The sign-in uses the same Entra app, redirect URI and delegated `openid profile` as self-serve setup and account linking. Its `tid` and `oid` must equal the setup link's tenant and Teams user, and no administrator role is needed. Before, the setup link alone connected the organization and linked the installer's Teams account to whoever completed it, so a forwarded setup link could link the installer's Teams account to someone else. `POST …/integrations/teams/bot/microsoft-sign-in` now returns an authorization URL for approved installers too, and `PUT …/integrations/teams/bot` without `microsoft` is refused with `microsoft_sign_in_required`. A different Microsoft account is refused with `user_mismatch` and connects nothing.
