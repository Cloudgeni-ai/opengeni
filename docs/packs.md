# Capability Packs

Capability packs are role-oriented bundles that expand into existing OpenGeni runtime primitives:

- MCP tool selections
- bundled skills
- connector requirements
- optional document-base knowledge
- scheduled-task templates
- task metadata

The first pack is `marketing-social-daily-analysis`. It enables a workspace to connect social accounts, attach marketing knowledge bases, and schedule a daily agent run that analyzes recent media performance.

## Architecture

OpenGeni keeps pack execution on the normal session and scheduled-task path. A pack does not create a second runtime. Instead, enabling a pack stores a `pack_installations` row and pack-specific flows create ordinary scheduled tasks with:

- `agentConfig.tools`: first-party MCP servers such as `opengeni` and `docs`; portable packs may mark deployment-specific MCP refs with `optional: true` so unconfigured servers are skipped and configured-but-unavailable servers degrade best-effort at runtime
- `agentConfig.resources`: files or repositories when needed
- `agentConfig.metadata`: pack ID, template ID, connector IDs, and knowledge IDs
- `agentConfig.prompt`: role-specific instructions compiled from the pack template

Connectors are durable account records, not secret records. `social_connections.credential_ref` points at an external credential broker or secret store. Raw OAuth tokens should not be stored in Postgres. Provider-specific OAuth brokers and sync workers can populate the same connector and post tables later.

CloudGeni used a similar split: a general integration record, provider-specific detail, and credential services that fetch/refresh secrets behind a provider abstraction. OpenGeni keeps the MVP simpler but preserves the same boundary through `credentialRef`.

Packs may also declare an `variable set` block (`description`, `requiredVariables`, `required`). Enabling such a pack accepts an `variableSetId` pointing at a workspace variable set (see `docs/variable-sets.md`); the required variable **names** are validated at enable time and scheduled tasks created from the pack's templates inherit the attachment. Variable sets store encrypted `NAME=value` material in Postgres under an operator key — a deliberate, documented contrast with the `credentialRef` rule above.

## Pack-Scoped Runtime

A registered pack manifest may declare the runtime its sessions compose into:

- `sandboxImage` (optional string): a container image ref — digest-pinned recommended — that the workspace's sessions run in. With one enabled image-declaring pack, the worker derives run settings with `dockerImage`/`modalImageRef` replaced by the pack image. With none, sessions keep the deployment-wide `OPENGENI_DOCKER_IMAGE` / `OPENGENI_MODAL_IMAGE_REF` behavior exactly. If **more than one** enabled pack declares an image, enabling the second pack fails with `409`, and a session start that still finds two (for example after a manifest re-registration) fails the turn with a plain error. There is deliberately no image composition or layering in v1. A pack `sandboxImage` in a **private** registry (a cloud-hosted ACR/ECR/GCR digest) requires the Modal backend to be configured with `OPENGENI_MODAL_IMAGE_REGISTRY_SECRET` (see the Modal section in [`../.env.example`](../.env.example)); the worker warms that pack-specific ref at turn time after pack settings resolve. The Modal registry Secret is resolved with the configured `OPENGENI_MODAL_TOKEN_ID`/`OPENGENI_MODAL_TOKEN_SECRET` client, so embedded hosts do not also need standard `MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET` env or `~/.modal.toml`. Without a registry secret the image is pulled unauthenticated and must be public.
- `skills` (optional array): skills delivered into the sandbox skill index. Each skill is `{ name, description?, files: [{ path, content }] }` where `files` must include a top-level `SKILL.md` and paths are safe relative POSIX paths (`references/...`, `scripts/...`). Skill content travels inline in the manifest and is stored with it (the `workspace_packs` JSONB row); no image baking or extra storage is involved. At run time the worker feeds enabled packs' skills into the OpenAI Agents SDK Skills capability alongside the bundled skills, so they appear in the same `.agents/` skill index, are lazily materialized via `load_skill`, and `skills/<name>` references resolve. A pack skill with the same directory name as a bundled skill shadows it; two enabled packs declaring the same skill name fail the turn plainly.

Built-in packs never declare `sandboxImage` or `skills`; only registered (manifest-backed) packs participate in pack-scoped runtime composition.

`sandboxImage` predates [rigs](rigs.md) and is superseded by them for new configuration: a rig's own `image`, when its version sets one, is the top of image precedence (**rig > pack > deployment default**) and overrides a pack's `sandboxImage` outright — a workspace with both a rig image and a pack image runs the rig's. `sandboxImage` still works unchanged for a workspace with no bound rig or a rig version with no image set.

## Marketing Social Pack

The pack exposes:

- Pack catalog and installation routes under `/v1/workspaces/:workspaceId/packs`
- Social connector routes under `/v1/workspaces/:workspaceId/social`
- OpenGeni MCP tools:
  - `social_connections_list`
  - `social_posts_recent`
  - `social_daily_analysis_context`
- Bundled skill: `social-media-marketing`
- Optional document knowledge through existing document-base routes and the `docs` MCP server

Provider OAuth and API access vary by platform. The pack manifest records official reference URLs for X OAuth 2.0 with PKCE, LinkedIn Community Management APIs, Instagram Graph API, TikTok APIs, and YouTube APIs. Use provider docs as the source of truth for scopes, approval, rate limits, and app review.

## Setup Flow

Enable the pack:

```bash
curl -X POST "http://127.0.0.1:8000/v1/workspaces/$WORKSPACE_ID/packs/marketing-social-daily-analysis/enable" \
  -H 'content-type: application/json' \
  -d '{"metadata":{"enabledBy":"operator"}}'
```

Register a connected social account. `credentialRef` should reference a secret-manager entry or OAuth broker record:

```bash
curl -X POST "http://127.0.0.1:8000/v1/workspaces/$WORKSPACE_ID/social/connections" \
  -H 'content-type: application/json' \
  -d '{
    "provider": "linkedin",
    "accountHandle": "example-company",
    "accountName": "Example Company",
    "externalAccountId": "urn:li:organization:123",
    "scopes": ["r_organization_social"],
    "credentialRef": "secret://marketing/linkedin/example-company"
  }'
```

Import or sync posts into OpenGeni:

```bash
curl -X POST "http://127.0.0.1:8000/v1/workspaces/$WORKSPACE_ID/social/posts" \
  -H 'content-type: application/json' \
  -d '{
    "connectionId": "00000000-0000-0000-0000-000000000000",
    "externalPostId": "post-123",
    "url": "https://www.linkedin.com/feed/update/urn:li:activity:123/",
    "authorHandle": "example-company",
    "text": "Launch announcement",
    "publishedAt": "2026-06-06T09:00:00Z",
    "metrics": { "impressions": 1200, "likes": 48, "comments": 6 }
  }'
```

Create the daily scheduled analysis task:

```bash
curl -X POST "http://127.0.0.1:8000/v1/workspaces/$WORKSPACE_ID/packs/marketing-social-daily-analysis/scheduled-tasks" \
  -H 'content-type: application/json' \
  -d '{
    "connectionIds": ["00000000-0000-0000-0000-000000000000"],
    "documentBaseIds": [],
    "timeZone": "Europe/Oslo",
    "hour": 9,
    "minute": 0,
    "promptInstructions": "Prioritize launch campaign learnings and concrete next actions."
  }'
```

The scheduled task runs through Temporal like any other OpenGeni scheduled task. During execution, the agent calls `opengeni__social_daily_analysis_context`, optionally searches document bases through the docs MCP server, and writes a daily report in the session timeline.

## Extension Points

Add new packs by adding a pack manifest with:

- stable `id`, `role`, `category`, and `version`
- required MCP tools
- bundled skill name
- connector definitions and scope metadata
- knowledge requirements
- scheduled task templates

Add new connector providers by writing an OAuth/API broker that:

- completes provider auth and stores raw tokens in a secret store
- creates or updates `social_connections` with a `credentialRef`
- syncs provider data into `social_posts`
- exposes richer MCP tools only when the provider needs live calls

Official references used for the first pack:

- X API OAuth 2.0 with PKCE: https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code
- LinkedIn Community Management APIs: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-overview
- Instagram Graph API: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/
- TikTok API v2: https://developers.tiktok.com/doc/tiktok-api-v2-introduction/
- Model Context Protocol transports: https://modelcontextprotocol.io/specification/draft/basic/transports
