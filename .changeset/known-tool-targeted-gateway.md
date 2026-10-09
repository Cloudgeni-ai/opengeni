---
"@opengeni/contracts": minor
"@opengeni/tool-gateway": minor
"@opengeni/db": minor
"@opengeni/runtime": patch
"@opengeni/sdk": minor
"@opengeni/react": patch
"@opengeni/codemode": patch
---

Add targeted current-human tool resolution and invocation without whole-workspace
provider discovery. Fence caller, pinned Site and selected live action policy
after awaited physical credential authorization. Preserve success/unknown
outcomes through cleanup failures, prevent stale retries on contradictory
transport flags, and retain Site entry pins through Codemode refresh. Preserve
live account authority, versioned executable-effect one-shot approval
bindings, optional full-definition preconditions, and explicit legacy discovery.
SDK calls use the targeted path by default; older APIs require explicit catalog
mode. Upgraded Site hosts adapt saved legacy bundles using bounded manifests.
Raw/local target approvals bind existing executable/configuration authority
instead of public catalog presentation. Retained catalog clients also veto
uncertain stale retries; explicit malformed pins are never silently omitted.
The host also separates executed stale-named provider diagnostics from legacy
Site retry control without rewriting saved bundles or changing success outputs.
Deploy rolling migration 0685 before enabling the new API and matched SDK/host.
