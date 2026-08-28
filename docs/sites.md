# OpenGeni Sites

OpenGeni Sites are the default application path for internal tools that can be
delivered as a static single-page application. OpenGeni hosts the presentation
code and supplies native AI plus approved integrations through one shared Site
Runtime Gateway. A Site does not receive a backend, Kubernetes workload,
serverless function, database, or long-lived browser credential.

Advanced Deployments are a separate, disabled-by-default path for applications
that genuinely need arbitrary server code or dedicated infrastructure. Their
OCI, target, plan, apply, observe, reconcile, rollback, and retire protocol is
documented in [internal-applications.md](internal-applications.md).

## User experience

1. Open **Sites** and author the interface in an ordinary durable OpenGeni
   session.
2. Preview the exact workspace HTML artifact in its isolated renderer.
3. Review the model, instructions, first-party tools, MCP integrations, personal
   Connection server allowlist, write-approval mode, workspace access, and
   monthly budget.
4. Publish an immutable release to
   `/workspaces/:workspaceId/sites/:siteId/run`.
5. The signed-in user opens that stable route. The OpenGeni shell loads the
   exact release into an opaque-origin iframe and supplies a page-lifetime
   `MessageChannel`.
6. Generated code calls `@opengeni/site-runtime`; the shell creates or
   continues ordinary durable sessions and forwards standard session events.
7. Manage release history, usage, activity, rollback, and archive from the Site
   page. None of these publication operations mutates infrastructure.

Phase one supports self-contained HTML SPAs. The release binds one exact
workspace artifact version and is forward-compatible with a later multi-file
asset manifest.

## Architecture and authority

```text
opaque static Site iframe
  | typed MessageChannel: ai.start / ai.send / ai.cancel
  v
authenticated OpenGeni Site shell
  | current user cookie stays here
  v
Site Runtime Gateway
  | recheck user + workspace + active Site + exact release + budget
  | freeze model + instructions + tools + release hashes + actor metadata
  v
ordinary durable OpenGeni session
  | SSE/replay, MCP/Connections, approvals, usage, audit, cancellation
  v
approved local or declared external model/data routes
```

The immutable capability manifest is a request ceiling, never an authority
source. Runtime admission intersects it with the current user's access grant.
Personal Connections require the full opaque common-user delegation tuple and
an explicitly allowed server ID. Existing MCP/Connection adapters recheck
connection state and ownership when tools execute, so revocation blocks new
work without rewriting history.

Session creation is deliberately staged. The gateway creates an empty durable
session shell, freezes the MCP approval policy, records the Site/release/session
link, and only then admits the first user message. This prevents the first turn
from racing ahead of the release's write policy. External MCP servers and
selected write-capable first-party tools require the ordinary platform approval
flow when `writeActions` is `platform_prompt`; `deny` rejects such a manifest at
runtime. The approval prompt is rendered by the authenticated parent shell,
never by generated HTML.

Every runtime session records Site ID, release ID, artifact version ID,
capability-manifest hash, creator, selected model/tool policy, and ordinary
session authority. Follow-ups are accepted only while that exact release is
still current. Rollback creates a new immutable release from the selected
historical artifact and manifest; it never mutates old evidence.

## Browser security boundary

The Site iframe has an opaque origin and only `allow-scripts` sandbox authority.
The runtime copy receives a reviewed CSP that disables network connections,
frames, workers, plugins, forms, and base-URL rewriting. Inline code, style, and
data/blob media support a self-contained SPA. The MessageChannel parser accepts
only bounded `ai.start`, `ai.send`, and `ai.cancel` requests.

The iframe never receives:

- an OpenGeni API key or authenticated cookie;
- a model-provider key;
- a Connection or integration credential;
- a Variable Set value;
- a signed URL or object-storage key; or
- a generic authenticated `fetch` proxy.

The platform injects the bridge only into the in-memory runtime copy. The
immutable artifact bytes and content digest remain unchanged.

## Where data resides

| Data | Residence | Site access path |
| --- | --- | --- |
| Static HTML | Configured OpenGeni object storage; metadata and SHA-256 identity in Postgres | Authenticated artifact read into the opaque iframe |
| Release manifest, head, lifecycle events | OpenGeni Postgres with workspace/account FORCE RLS | Parent shell and gateway only |
| Session messages, events, approvals, usage | Existing durable OpenGeni Postgres/session stores | Standard session APIs and SSE through the parent shell |
| Files, documents, knowledge | OpenGeni's configured local/provider-native storage and indexes | Exact first-party tools allowed by the release and user grant |
| Source-system data | Its existing approved system of record | Server-side Connection/MCP/API adapter; no direct browser database access |
| Connection and Variable Set credentials | Authenticated-encrypted OpenGeni storage or the configured secret manager | Resolved just in time by the server-side adapter; never returned to Site code |
| Model input/output | The configured inference route | Ordinary OpenGeni model policy and durable session boundary |

For a closed SINTEF-style path, Site hosting, Postgres/object storage, knowledge
or the read-only data adapter, and model routing must all be inside the approved
environment. A local Site by itself does not make an external model route local.
The reproducible reference and evidence checklist are in
[`deploy/examples/sites/sintef-local-data`](../deploy/examples/sites/sintef-local-data/README.md).

## Public surfaces

All routes are workspace-authenticated and return 404 while Sites are disabled:

- `GET /v1/workspaces/:workspaceId/sites`
- `GET /v1/workspaces/:workspaceId/sites/:siteId`
- `POST /v1/workspaces/:workspaceId/sites/:siteId/releases`
- `POST /v1/workspaces/:workspaceId/sites/:siteId/rollback`
- `POST /v1/workspaces/:workspaceId/sites/:siteId/archive`
- `GET /v1/workspaces/:workspaceId/sites/:siteId/usage`
- `POST /v1/workspaces/:workspaceId/sites/:siteId/runtime/sessions`
- `POST /v1/workspaces/:workspaceId/sites/:siteId/runtime/sessions/:runtimeSessionId/messages`

The artifact-aware `@opengeni/sdk/artifacts` client exposes the same lifecycle.
Generated code uses only the zero-network `@opengeni/site-runtime` package:

```ts
import { connect } from "@opengeni/site-runtime";

const site = await connect();
const receipt = await site.ai.start({
  message: "Summarize the approved local evidence",
});

site.onEvent(({ sessionId, event }) => {
  if (sessionId === receipt.sessionId) render(event);
});

await site.ai.send({
  runtimeSessionId: receipt.runtimeSession.id,
  text: "Now compare the two strongest observations",
});
```

The standard OpenGeni event stream remains the source of truth. The bridge does
not invent a second conversation or approval protocol.

## Feature flags and rollout

Both lanes are false by default and independent:

```env
OPENGENI_SITES_ENABLED=false
OPENGENI_ADVANCED_DEPLOYMENTS_ENABLED=false
```

Enable `OPENGENI_SITES_ENABLED=true` on API and web only after migration 0374,
object storage, session workers, model routing, and the intended workspace
grants are ready. Enabling Sites grants no Kubernetes/cloud authority. Enabling
Advanced Deployments does not expose Sites.

Canonical implementation:

- contracts: `packages/contracts/src/sites.ts`;
- persistence: `packages/db/drizzle/0374_workspace_sites.sql`,
  `packages/db/src/sites-schema.ts`, and `packages/db/src/sites.ts`;
- gateway: `apps/api/src/routes/sites.ts`;
- browser runtime: `packages/site-runtime`,
  `packages/sdk/src/site-runtime-browser.ts`, and
  `apps/web/src/components/sites/site-runtime-frame.tsx`;
- product UX: `apps/web/src/routes/sites.tsx`;
- trusted reference publisher: `scripts/sites-publish.ts`.
