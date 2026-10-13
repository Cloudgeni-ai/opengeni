---
"@opengeni/api-router": patch
---

API images ship a bundled `scripts/admission-settings.ts` command that prints the parsed user-admission policy and deployment revision, so deployment verifiers can prove the serving policy now that the API runtime is bundled and `@opengeni/config` is no longer importable by name.
