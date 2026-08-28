# OpenGeni Docs Map

This map defines who each doc tier serves and where volatile facts belong.

## Audiences

| Audience | Reads | Notes |
| --- | --- | --- |
| Integrator | `README.md`, `packages/sdk/README.md`, `packages/react/README.md`, `docs/embedding-workbench.md` | Products consuming a standalone OpenGeni deployment; `docs/embedding.md` is only for advanced in-process hosts. |
| Maintainer | `CONTRIBUTING.md`, `docs/architecture.md`, topic docs | Contributors changing code, packages, workflows, or release mechanics. |
| Repo agent | `AGENTS.md`, `.agents/skills/opengeni/SKILL.md`, this map | Coding agents working in this repository. |
| Integration agent | `.agents/skills/opengeni-client/SKILL.md` and its references | Customer-side coding agents choosing and implementing a product integration shape. |
| Product agent | Curated opt-in Skills in `packages/runtime/src/curated_skill_library` plus native tool-bound Skills in `packages/runtime/src/bundled_artifact_skills` and `packages/runtime/src/bundled_video_skills` | Versioned product content; not covered by this freshness system. |
| Operator | `docs/deployment.md`, deployment contracts and chart docs | People deploying and operating OpenGeni. |
| Record | `docs/design/**` | Public-safe point-in-time architecture and product-design records; never raw operator evidence. |

## Canonical Homes

| Topic | Current canonical home | Known restatement locations |
| --- | --- | --- |
| Architecture & package layout | `docs/architecture.md` | `README.md`, `AGENTS.md`, package READMEs should link or summarize lightly. |
| Standalone product integration | `packages/sdk/README.md`, `packages/react/README.md` | `docs/embedding-workbench.md` owns the optional workbench; `.agents/skills/opengeni-client/` owns agent guidance. |
| Advanced in-process embedding & ports | `docs/embedding.md` | `README.md` and `CONTRIBUTING.md` should not present it as the default customer path. |
| Run lifecycle | `docs/run-lifecycle.md` | `AGENTS.md`, `.agents/skills/opengeni/SKILL.md`, architecture summaries should link. |
| Codex subscription rotation | `docs/codex-subscription-rotation.md` | `docs/run-lifecycle.md`, `docs/architecture.md`, and operator notes should link instead of restating allocator/failure semantics. |
| SuperGrok/xAI subscription authority and rotation | `docs/supergrok-subscription.md` | `docs/run-lifecycle.md`, `docs/architecture.md`, provider/operator docs, SDK/React docs, and UI copy should link instead of restating authority or capacity semantics. |
| Per-session MCP servers | `docs/session-mcp-servers.md` | `docs/architecture.md`, SDK/client examples should link instead of restating credential semantics. |
| Connected machines | `docs/connected-machines.md` | `README.md`, `AGENTS.md`, client docs and skills should link. |
| Deployment | `docs/deployment.md` | `README.md`, `AGENTS.md`, Helm/Terraform notes should link. |
| Organization tenancy authority, activation, and rollback boundary | `docs/organization-tenancy.md` | `docs/deployment.md` owns the operator cutover procedure; `docs/architecture.md`, `AGENTS.md`, and chart/config comments should link instead of restating the boundary, the preconditions, or the pre-activation opt-out switch. |
| Organization recovery custody, immutable workspace ownership, and rollout | `docs/organization-recovery.md` | `docs/organization-tenancy.md` owns the broader tenancy model; deployment, API, SDK, and UI notes should link instead of weakening the quorum, actor-fence, notification, or unsupported-operation boundaries. |
| FORCE-RLS migration backfills | `docs/force-rls-migration-backfills.md` | `AGENTS.md`, `docs/deployment.md`, and migration comments should link instead of restating the owner-only `NO FORCE` window, the guard, or the classification inventory. |
| Release/publishing | `CONTRIBUTING.md` § Release / Publishing, plus workflow files as executable truth | `README.md`, package READMEs, architecture release notes should link. |
| Pull-request delivery across moving `main` | `AGENTS.md` § Pull-request delivery across moving `main`; hotfix freeze-head admission in `.github/workflows/source-admission.yml` and `scripts/check-source-admission.mjs`; promote/hotfix loop in `CONTRIBUTING.md` § Release / Publishing | `.agents/skills/opengeni/SKILL.md`, the PR template, and `docs/deployment.md` must preserve the same immutable-candidate distinction. Ordinary PRs into `main` do not run source admission. |
| Client/SDK integration | `packages/sdk/README.md` | `README.md`, `packages/react/README.md`, and customer integration skills should link. |
| Composer voice input | `docs/transcription.md` | Architecture, SDK/React docs, and host-app guides should link instead of restating provider selection or microphone lifecycle rules. |
| Workbench embedding & production acceptance | `docs/embedding-workbench.md`, `docs/workbench-acceptance.md` | Host-app guides should link instead of weakening or restating the live evidence contract. |
| Credential taxonomy | `docs/credentials.md` | `docs/embedding.md`, `docs/capabilities.md`, route comments should link instead of re-listing token types. |
| GitHub App workspace binding | `docs/github-app.md` | `README.md`, `docs/architecture.md`, API/MCP/UI copy should summarize without weakening the authority matrix. |
| Personal GitHub identity, repository authority, local setup, and propagation | `docs/personal-github.md` | `docs/github-app.md`, `docs/deployment.md`, API/runtime/UI copy should link instead of restating token custody or grant semantics. |
| OpenGeni Review Bot PR-review automation | `docs/pr-review-pack.md` | `docs/packs.md`, `docs/github-app.md`, architecture, SDK, and UI copy should link instead of restating provider permissions, delivery semantics, or exact-head authority. |
| Google Drive connection, scheduled source sync, and release readiness | `docs/google-drive.md` | Capabilities UI, connector code, and deployment guides should link instead of restating OAuth scope, explicit enablement, bounded sync/retry behavior, release gates, or ACL/citation boundaries. |
| OpenGeni Slack bot connection | `docs/slack-bot.md` | Capabilities/scheduled-task UI and architecture should link instead of restating manifest or routing rules. |
| Social connectors (X / Reddit) | `docs/social-connectors.md` | `docs/architecture.md`, pack/capability UI copy, and marketing-pack docs should link instead of restating OAuth endpoints, scopes, or token-handling rules. |
| Fiken connector (accounting) | `docs/fiken.md` | Capabilities UI copy and architecture should link instead of restating token verification, company scoping, or the single-concurrent-request rule. |
| First-party local MCP bridges | `docs/design/first-party-mcp-bridges.md` | Provider bridge adapters, catalog/runtime registration, and follow-ups must preserve its authority, destination, and mutation-replay contract. |
| Rigs (versioned sandbox machine definitions) | `docs/rigs.md` | `docs/architecture.md`, `docs/packs.md`, `docs/variable-sets.md`, `docs/capabilities.md` should link instead of restating verification/promotion rules. |
| Event-triggered automations | `docs/automations.md` | Provider adapters and Packs should link here rather than creating a second event/run/session engine or weakening ingress/action-credential separation. |
| Nested-agent depth policy | `docs/nested-agent-depth.md` | `docs/architecture.md`, API/session comments, and release notes should link instead of restating admission and denial semantics. |
| Agent session authority | `docs/agent-session-authority.md` | `docs/architecture.md`, `AGENTS.md`, and nested-depth notes should link instead of restating peer-session access. |
| Advisory work discovery and durable work claims | `docs/work-discovery.md` | MCP, SDK, topology UI, deployment, authority, lifecycle, and observability docs should link here instead of weakening permission-first filtering, non-exclusive claims, advisory-only presentation, or rollout controls. |
| Workspace instruction policies | `docs/workspace-instruction-policies.md` | `docs/architecture.md`, API/SDK comments, and future runtime/UI work should link instead of weakening activation, audit, or legacy-fallback semantics. |
| Organization identity | `docs/company-profile.md` | The account-scoped identity/mission authority, compatibility revisions, activation/rollback, exact-attempt snapshots, organization-knowledge boundary, and mandatory prompt precedence. |
| Workspace learning policy | `docs/workspace-learning-policy.md` | The canonical durable-learning router, future evaluator/controller, source settings, and Agent Brain UI should consume this version/effective-mode contract instead of creating source-specific policy paths. |
| Workspace State inventory and bounded administration | `docs/workspace-state.md` | `docs/architecture.md`, the Workspace State API/SDK/UI, and point-in-time reconciliation records should link here for bounds, authorization, canonical-authority mutations, and authority fences. |
| Structured preference registry | `docs/preference-registry.md` | `docs/architecture.md`, API/MCP/SDK comments, and future runtime/UI work should link instead of weakening proposal-only imports, initiator binding, snapshot retrieval, or scope authorization. |
| Hierarchical workspace memory foundation | `docs/hierarchical-memory.md` | `docs/architecture.md`, DB/domain comments, and future API/runtime/UI slices should link instead of weakening typed-scope RLS, immutable actor evidence, or maintenance-cutover semantics. |
| Scoped knowledge provenance | `docs/scoped-knowledge.md` | Source/document bridges, future connectors, claim retrieval, and policy/preference materialization should link here instead of weakening fixed authority, ACL intersection, tombstone, legacy non-widening, or proposal-only invariants. |
| MCP surface selection | `docs/mcp-surfaces.md` | `docs/architecture.md`, `docs/capabilities.md`, `docs/session-mcp-servers.md` should link. |
| First-party MCP response contracts | `docs/mcp-response-contracts.md` | Mutation handlers, consumer migration notes, and release notes should link instead of restating the receipt schema and tool classification. |
| Codemode programmatic tool access | `docs/mcp-surfaces.md`, `docs/architecture.md`; record design in `docs/design/codemode.md` | Runtime/API/worker comments should link instead of restating security invariants. |
| Client/server compatibility policy | `docs/architecture.md` §3.10 | `packages/sdk/README.md` links; release notes should link. |
| Typecheck/lint/format toolchain | `docs/toolchain.md` | `CONTRIBUTING.md` links; other docs should not restate tool choice or version. |
| Model catalog pricing audit | `docs/model-providers.md` § Price audit (`bun run check:model-pricing`) | Debit authority stays in `packages/config` `defaultModelPricing`; llm-prices is a canary only. |
| Provider-aware image generation | `docs/image-generation.md` | Runtime, worker, artifact, SDK, and React summaries should link instead of restating provider and recovery semantics. |

## Rules

1. Volatile facts such as paths, package names, commands, and env vars live in the canonical home; other docs link instead of restating.
2. `docs/design/**` is a public record tier. Add the point-in-time banner and `<!-- docs-refs: record -->` marker; do not "freshen" those docs. Raw run logs, screenshots/video, reviewer transcripts, private issue links, production identifiers/metrics, personal paths, and credentials belong in private artifact storage, never this repository.
3. Current-tier freshness is enforced in CI by `scripts/check-docs-refs.ts`.
