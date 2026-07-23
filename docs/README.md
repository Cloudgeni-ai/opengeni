# OpenGeni Docs Map

This map defines who each doc tier serves and where volatile facts belong.

## Audiences

| Audience | Reads | Notes |
| --- | --- | --- |
| Integrator | `README.md`, `docs/embedding.md`, `packages/sdk/README.md` | OSS self-hosters and embedding hosts building against OpenGeni. |
| Maintainer | `CONTRIBUTING.md`, `docs/architecture.md`, topic docs | Contributors changing code, packages, workflows, or release mechanics. |
| Repo agent | `AGENTS.md`, `.agents/skills/opengeni/SKILL.md`, this map | Coding agents working in this repository. |
| Product agent | Bundled skills in `packages/runtime/src/bundled_hashicorp_terraform_skills` and curated entries in `packages/runtime/src/bundled_skill_library` | Versioned product content; not covered by this freshness system. |
| Operator | `docs/deployment.md`, deployment contracts and chart docs | People deploying and operating OpenGeni. |
| Record | `docs/design/**` | Public-safe point-in-time architecture and product-design records; never raw operator evidence. |

## Canonical Homes

| Topic | Current canonical home | Known restatement locations |
| --- | --- | --- |
| Architecture & package layout | `docs/architecture.md` | `README.md`, `AGENTS.md`, package READMEs should link or summarize lightly. |
| Embedding & ports | `docs/embedding.md` | `README.md`, `CONTRIBUTING.md`, SDK/client examples should link. |
| Run lifecycle | `docs/run-lifecycle.md` | `AGENTS.md`, `.agents/skills/opengeni/SKILL.md`, architecture summaries should link. |
| Codex subscription rotation | `docs/codex-subscription-rotation.md` | `docs/run-lifecycle.md`, `docs/architecture.md`, and operator notes should link instead of restating allocator/failure semantics. |
| Per-session MCP servers | `docs/session-mcp-servers.md` | `docs/architecture.md`, SDK/client examples should link instead of restating credential semantics. |
| Connected machines | `docs/connected-machines.md` | `README.md`, `AGENTS.md`, client docs and skills should link. |
| Deployment | `docs/deployment.md` | `README.md`, `AGENTS.md`, Helm/Terraform notes should link. |
| Release/publishing | `CONTRIBUTING.md` § Release / Publishing, plus workflow files as executable truth | `README.md`, package READMEs, architecture release notes should link. |
| Client/SDK integration | `packages/sdk/README.md` | `README.md`, `docs/embedding.md`, `@opengeni/react` docs should link. |
| Composer transcription | `docs/transcription.md` | Architecture, SDK/React docs, and host-app guides should link instead of restating provider authorization or lifecycle rules. |
| Workbench embedding & production acceptance | `docs/embedding-workbench.md`, `docs/workbench-acceptance.md` | Host-app guides should link instead of weakening or restating the live evidence contract. |
| Credential taxonomy | `docs/credentials.md` | `docs/embedding.md`, `docs/capabilities.md`, route comments should link instead of re-listing token types. |
| Rigs (versioned sandbox machine definitions) | `docs/rigs.md` | `docs/architecture.md`, `docs/packs.md`, `docs/variable-sets.md`, `docs/capabilities.md` should link instead of restating verification/promotion rules. |
| MCP surface selection | `docs/mcp-surfaces.md` | `docs/architecture.md`, `docs/capabilities.md`, `docs/session-mcp-servers.md` should link. |
| Toolspace programmatic tool access | `docs/mcp-surfaces.md`, `docs/architecture.md`; record design in `docs/design/toolspace.md` | Runtime/API/worker comments should link instead of restating security invariants. |
| Client/server compatibility policy | `docs/architecture.md` §3.10 | `packages/sdk/README.md` links; release notes should link. |
| Typecheck/lint/format toolchain | `docs/toolchain.md` | `CONTRIBUTING.md` links; other docs should not restate tool choice or version. |

## Rules

1. Volatile facts such as paths, package names, commands, and env vars live in the canonical home; other docs link instead of restating.
2. `docs/design/**` is a public record tier. Add the point-in-time banner and `<!-- docs-refs: record -->` marker; do not "freshen" those docs. Raw run logs, screenshots/video, reviewer transcripts, private issue links, production identifiers/metrics, personal paths, and credentials belong in private artifact storage, never this repository.
3. Current-tier freshness is enforced in CI by `scripts/check-docs-refs.ts`.
