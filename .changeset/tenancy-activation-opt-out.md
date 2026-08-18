---
"@opengeni/config": minor
---

Named pre-activation opt-out for canonical organization-tenancy authority: `OPENGENI_ORGANIZATION_TENANCY_CANONICAL_ACTIVATION_ENABLED` (`organizationTenancyCanonicalActivationEnabled`) defaults to `false`, the reversible pre-activation posture, and is parsed with `EnvBoolean` so an explicit `false` cannot be coerced into activation. Leaving it unset or false is the supported way to decline or defer the one-way tenancy cutover; it is not a kill switch, and setting it back to false after an activation migration commits restores nothing. The chart's `config` map and `.env.example` pin the same safe default. The rollback boundary, activation preconditions, and operator procedure are documented in `docs/organization-tenancy.md` and `docs/deployment.md`.
