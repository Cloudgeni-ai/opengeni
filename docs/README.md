# OpenGeni Docs Map

This map defines who each doc tier serves and where volatile facts belong.

## Audiences

| Audience | Reads | Notes |
| --- | --- | --- |
| Integrator | `README.md`, `packages/sdk/README.md`, `packages/react/README.md`, `docs/embedding-workbench.md` | Products consuming a standalone OpenGeni deployment; `docs/embedding.md` is only for advanced in-process hosts. |
| Maintainer | `CONTRIBUTING.md`, `docs/architecture.md`, topic docs | Contributors changing code, packages, workflows, or release mechanics. |
| Repo agent | `AGENTS.md`, `.agents/skills/opengeni/SKILL.md`, this map | Coding agents working in this repository. |
| Integration agent | `.agents/skills/opengeni-client/SKILL.md` and its references | Customer-side coding agents choosing and implementing a product integration shape. |
| Product agent | Bundled skills in `packages/runtime/src/bundled_hashicorp_terraform_skills` and curated entries in `packages/runtime/src/bundled_skill_library` | Versioned product content; not covered by this freshness system. |
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
| Per-session MCP servers | `docs/session-mcp-servers.md` | `docs/architecture.md`, SDK/client examples should link instead of restating credential semantics. |
| Connected machines | `docs/connected-machines.md` | `README.md`, `AGENTS.md`, client docs and skills should link. |
| Deployment | `docs/deployment.md` | `README.md`, `AGENTS.md`, Helm/Terraform notes should link. |
| Release/publishing | `CONTRIBUTING.md` § Release / Publishing, plus workflow files as executable truth | `README.md`, package READMEs, architecture release notes should link. |
| Client/SDK integration | `packages/sdk/README.md` | `README.md`, `packages/react/README.md`, and customer integration skills should link. |
| Composer voice input | `docs/transcription.md` | Architecture, SDK/React docs, and host-app guides should link instead of restating provider selection or microphone lifecycle rules. |
| Workbench embedding & production acceptance | `docs/embedding-workbench.md`, `docs/workbench-acceptance.md` | Host-app guides should link instead of weakening or restating the live evidence contract. |
| Credential taxonomy | `docs/credentials.md` | `docs/embedding.md`, `docs/capabilities.md`, route comments should link instead of re-listing token types. |
| GitHub App workspace binding | `docs/github-app.md` | `README.md`, `docs/architecture.md`, API/MCP/UI copy should summarize without weakening the authority matrix. |
| Google Drive source preview | `docs/google-drive.md` | Capabilities UI and connector code should link instead of restating OAuth scope and no-ingestion boundaries. |
| OpenGeni Slack bot connection | `docs/slack-bot.md` | Capabilities/scheduled-task UI and architecture should link instead of restating manifest or routing rules. |
| Social connectors (X / Reddit) | `docs/social-connectors.md` | `docs/architecture.md`, pack/capability UI copy, and marketing-pack docs should link instead of restating OAuth endpoints, scopes, or token-handling rules. |
| Rigs (versioned sandbox machine definitions) | `docs/rigs.md` | `docs/architecture.md`, `docs/packs.md`, `docs/variable-sets.md`, `docs/capabilities.md` should link instead of restating verification/promotion rules. |
| Nested-agent depth policy | `docs/nested-agent-depth.md` | `docs/architecture.md`, API/session comments, and release notes should link instead of restating admission and denial semantics. |
| Workspace instruction policies | `docs/workspace-instruction-policies.md` | `docs/architecture.md`, API/SDK comments, and future runtime/UI work should link instead of weakening activation, audit, or legacy-fallback semantics. |
| Organization company profile | `docs/company-profile.md` | The account-scoped concise profile, immutable revisions/activation/rollback, durable-learning adapter seam, exact-attempt snapshots, and mandatory prompt precedence. |
| Workspace State inventory and bounded administration | `docs/workspace-state.md` | `docs/architecture.md`, the Workspace State API/SDK/UI, and point-in-time reconciliation records should link here for bounds, authorization, canonical-authority mutations, and authority fences. |
| Structured preference registry | `docs/preference-registry.md` | `docs/architecture.md`, API/MCP/SDK comments, and future runtime/UI work should link instead of weakening proposal-only imports, initiator binding, snapshot retrieval, or scope authorization. |
| Hierarchical workspace memory foundation | `docs/hierarchical-memory.md` | `docs/architecture.md`, DB/domain comments, and future API/runtime/UI slices should link instead of weakening typed-scope RLS, immutable actor evidence, or maintenance-cutover semantics. |
| Scoped knowledge provenance | `docs/scoped-knowledge.md` | Source/document bridges, future connectors, claim retrieval, and policy/preference materialization should link here instead of weakening fixed authority, ACL intersection, tombstone, legacy non-widening, or proposal-only invariants. |
| MCP surface selection | `docs/mcp-surfaces.md` | `docs/architecture.md`, `docs/capabilities.md`, `docs/session-mcp-servers.md` should link. |
| First-party MCP response contracts | `docs/mcp-response-contracts.md` | Mutation handlers, consumer migration notes, and release notes should link instead of restating the receipt schema and tool classification. |
| Toolspace programmatic tool access | `docs/mcp-surfaces.md`, `docs/architecture.md`; record design in `docs/design/toolspace.md` | Runtime/API/worker comments should link instead of restating security invariants. |
| Client/server compatibility policy | `docs/architecture.md` §3.10 | `packages/sdk/README.md` links; release notes should link. |
| Typecheck/lint/format toolchain | `docs/toolchain.md` | `CONTRIBUTING.md` links; other docs should not restate tool choice or version. |
| Model catalog pricing audit | `docs/model-providers.md` § Price audit (`bun run check:model-pricing`) | Debit authority stays in `packages/config` `defaultModelPricing`; llm-prices is a canary only. |
| Provider-aware image generation | `docs/image-generation.md` | Runtime, worker, artifact, SDK, and React summaries should link instead of restating provider and recovery semantics. |

## Rules

1. Volatile facts such as paths, package names, commands, and env vars live in the canonical home; other docs link instead of restating.
2. `docs/design/**` is a public record tier. Add the point-in-time banner and `<!-- docs-refs: record -->` marker; do not "freshen" those docs. Raw run logs, screenshots/video, reviewer transcripts, private issue links, production identifiers/metrics, personal paths, and credentials belong in private artifact storage, never this repository.
3. Current-tier freshness is enforced in CI by `scripts/check-docs-refs.ts`.
