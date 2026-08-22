# Event-triggered automations

OpenGeni automations translate authenticated external events into ordinary agent sessions. Pull-request review is one adapter and Pack built on this substrate; it is not a separate execution engine.

## Model

- A **source** owns an adapter, an opaque public webhook endpoint, non-secret adapter configuration, an encrypted ingress secret, an active/disabled lifecycle, and a monotonic version.
- A **trigger** points at one source. Its immutable revisions own event matching plus the complete session template. `configuration` is Pack-frozen policy, while bounded `parameters` hold per-installation values such as an exact repository binding. A mutable head selects the current revision and active/paused/disabled status.
- An **event** is the normalized, bounded result of one authenticated provider delivery. It freezes the accepted source version/configuration and matched trigger revisions, so recovery never resamples newer configuration. `(source, delivery key)` deduplicates transport retries and the raw-byte digest rejects a reused delivery identity with different bytes. One event may match at most 32 triggers.
- A **run** is one trigger accepting one logical occurrence. `(trigger, occurrence key)` converges distinct provider deliveries for the same work. It freezes the exact accepted execution and later links to one ordinary session.

The provider delivery ID is never a session ID. The run ID owns session-create idempotency, fixing providers that redeliver the same logical occurrence under new delivery IDs.

## Trust and authority

The public endpoint contains only a random routing UUID. The route resolves that UUID through the credential-free `automation_webhook_endpoints` table, then loads the FORCE-RLS source and authenticates the bounded raw request before parsing it. Adapter payload data is untrusted model input, not instruction or permission authority.

Ingress authentication and agent action credentials are separate authorities. The generic substrate stores only the source's webhook verification secret. Provider adapters own their action-credential bindings and must mint the narrow, short-lived credential for the exact run/session at use time; event payloads never supply credentials or permission grants.

Dispatch is a bounded Temporal control workflow. Immediately before the session shell and run linkage commit together, it rechecks:

- source is active and its version still matches the accepted event;
- trigger is active and its current revision still matches;
- a Pack-owned trigger's installation is still active;
- the accepted execution matches the run's account, workspace, source, trigger, revision, and event.

A revoked or changed authority skips the run. A transient dispatch failure is retryable and reuses `automation-run:<run id>` for session-create idempotency. The actual agent turn remains owned by the ordinary session workflow and its non-retryable turn activity.

Automations cannot select `selfhosted` compute because no interactive machine owner is present. Model policy, billing admission, usage recording, session tool policy, sandbox policy, and all normal turn controls continue to apply.

## Generic signed JSON adapter

`signed-json.v1` makes the substrate useful without a provider-specific Pack. It accepts a strict JSON object with `type`, optional `id`/`occurrenceKey`/time/subject/resource, and a `data` object. Send:

- `x-opengeni-signature-256: sha256=<HMAC-SHA256 of exact raw body>`
- optional `x-opengeni-delivery-id`; otherwise the authenticated raw request digest is the delivery identity

Workspace admins manage sources and triggers under `/v1/workspaces/:workspaceId/automations/...`. Manual event injection uses the authenticated source event endpoint. External systems post only to `/v1/webhooks/automations/:endpointId`.

## Packs

A Pack may declare `automationTemplates`. Installing a Pack makes these frozen templates available but does not manufacture a provider connection. After the required connection/app is registered, setup instantiates a trigger tied to both the exact Pack installation and template. Pack-owned configuration and execution fields are immutable; per-installation `parameters`, pause/disable, and display-name edits remain revisioned. Disabling or uninstalling the Pack prevents a pending run from dispatching.

Canonical implementation:

- contracts: `packages/contracts/src/index.ts`
- adapters and accepted execution: `packages/core/src/domain/automations.ts`
- persistence: `packages/db/src/automations.ts`, `packages/db/src/schema.ts`, migration `0316_event_triggered_automations.sql`
- HTTP: `apps/api/src/routes/automations.ts`
- orchestration: `apps/worker/src/workflows/automations.ts`, `apps/worker/src/activities/automations.ts`
- optional client: `@opengeni/sdk/automations`
