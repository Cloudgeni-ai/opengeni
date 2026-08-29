# Advanced Deployments

Advanced Deployments are the phase-two path for applications that need an
arbitrary backend, dedicated state, or customer-owned serving infrastructure.
The internal-application control plane turns a prompt or repository into a
reviewable application definition, binds it to governed data, and deploys an
immutable bundle onto approved organization-controlled compute. It is closest
to “Lovable for internal teams,” but the application, data, inference, and
deployment control planes remain inside explicit tenant boundaries.

Static internal SPAs should use [OpenGeni Sites](sites.md): the Sites path has
native AI and approved integrations without a per-application workload. The two
lanes have explicit `static_spa` and `external_deployment` runtime kinds and
independent disabled-by-default flags.

The preview is disabled by default. Set
`OPENGENI_ADVANCED_DEPLOYMENTS_ENABLED=true` on the API and web deployment only
after the target cluster, internal ingress, runtime credential, data credential
references, and local inference route have been reviewed. When disabled, the
client configuration reports `advancedDeployments.enabled=false`, navigation
is hidden, and authenticated API calls return `404` before request bodies are
parsed.

## What a user experiences

1. Open **Advanced deployments** in a workspace and describe the application.
2. Select approved data sources. Each binding freezes the source revision,
   access mode, read/write permissions, and a stable mount name.
3. Start a durable **Build in OpenGeni** session. The ordinary session UI shows
   live progress, files, tests, tools, approvals, steering, and a disposable
   preview while the agent works from frozen schema and target capability facts.
4. Publish through a trusted build pipeline and register its immutable image,
   SBOM, and provenance digests. The build agent cannot self-assert them.
5. Select an approved compute target and preview a deterministic plan.
6. Review capacity, locality, model egress, native-AI credentials, network
   policy, data movement, estimated cost, and all provider actions.
7. Explicitly approve production or data-writing plans, then apply.
8. Use the internal URL, observe health and drift, roll back to the prior
   bundle, or retire the environment.

The UI never claims that describing an app has changed infrastructure. Draft,
build session, bundle, plan, approval, provider start, provider result,
observation, rollback, and retirement are distinct durable states.

## Where data resides

The catalog stores a credential-free locator, schema description, governance
facts, and revision. Primary data remains in its system of record:

| Mode | Residence and lifecycle |
| --- | --- |
| `attach` | The app talks to the existing database, object store, document service, vector service, or API in place. This is the implemented Kubernetes preview path and defaults to read-only. |
| `clone` | An approved target lifecycle broker creates a bounded copy at the target site, returns only an audit digest, and injects runtime access through the declared Kubernetes Secret name. The plan always requires approval. |
| `provision` | The same broker creates isolated application-owned state and retires it with the environment. OpenGeni sends frozen schema/governance facts and Secret references, never credentials. |

For Kubernetes attach mode, `OPENGENI_DATA_BINDINGS_JSON` contains only safe
locator and policy facts. A binding with a Connection reference receives an
`envFrom` reference to `<dataCredentialSecretPrefix>-<mountName>`; OpenGeni does
not read or persist that Kubernetes Secret. The Secret's keys are an agreement
between the application image and the local operator. The plan fails before
apply when a credential-bearing source has no Secret prefix.

Strict locality is an end-to-end property. A fully local SINTEF demonstration
keeps all of these at the same approved site:

- the OpenGeni API, workers, Postgres history, object storage, and event bus;
- the deployed application and internal ingress;
- attached databases or file services;
- the configured model endpoint; and
- backups, logs, traces, and derived application data.

A Connected Machine alone does not establish data locality because model input
may still enter OpenGeni history or a remote inference provider.

Clone/provision are enabled only when the Kubernetes target declares an HTTPS
`dataLifecycleBroker`, a workspace Connection for its control credential, and
the exact supported modes. Apply calls the broker with the immutable plan
digest as its idempotency key before workload mutation. The response must match
the exact binding count and carry a SHA-256 audit digest; credentials or signed
URLs are not accepted. Transport/5xx ambiguity settles the deployment operation
as unknown. Disabling a source, target, bundle, or broker Connection blocks new
apply/observe/rollback access immediately, while retirement retains a narrow
cleanup path so revocation cannot strand provisioned resources.

## Native AI inside the finished application

The deployed app receives `OPENGENI_RUNTIME_URL`, `OPENGENI_WORKSPACE_ID`,
`OPENGENI_INTERNAL_APPLICATION_ID`, the frozen default model, and an
`OPENGENI_API_KEY` reference from
`<runtimeCredentialSecretPrefix>-<applicationSlug>`. Mint a separate workspace
API key for each app with only `sessions:create`, `sessions:read`, and
`sessions:control`, then store it under the Secret's `apiKey` key. Do not use an
administrator key.

The app starts AI work with the SDK's
`createInternalApplicationAiSession`. The endpoint:

- requires an active application deployment;
- selects only a model in the frozen application revision's allowlist;
- creates a durable OpenGeni session with the application and deployment
  identities recorded in metadata;
- exposes no first-party tools by default; and
- treats `modelContext` as ordinary durable user content, never as secret or
  privileged instruction authority.

```ts
import { OpenGeniClient } from "@opengeni/sdk";

const client = new OpenGeniClient({
  baseUrl: process.env.OPENGENI_RUNTIME_URL!,
  apiKey: process.env.OPENGENI_API_KEY!,
});

const receipt = await client.createInternalApplicationAiSession(
  process.env.OPENGENI_WORKSPACE_ID!,
  process.env.OPENGENI_INTERNAL_APPLICATION_ID!,
  {
    operationId: crypto.randomUUID(),
    initialMessage: "Summarize this approved experiment",
    modelContext: JSON.stringify(approvedRecord),
  },
);

for await (const event of client.streamEvents(
  process.env.OPENGENI_WORKSPACE_ID!,
  receipt.sessionId,
)) {
  // Project the durable event stream into the application's own UX.
}
```

Follow-up messages, streaming, approvals, and cancellation use the ordinary
session SDK. Application-specific data access stays in application code; only
the exact excerpts intentionally supplied as `modelContext` or messages become
OpenGeni session history.

## Control-plane resources

The preview adds eight workspace-owned, FORCE-RLS tables:

- applications and immutable application revisions;
- governed data sources and deployment targets;
- immutable bundles;
- deployments and idempotent deployment operations; and
- append-only application events.

Every mutable catalog write uses compare-and-swap revision checks. Creation,
build-session creation, bundle registration, planning, applying, observation,
rollback, and retirement have caller operation IDs. Reusing an ID with a
different payload is a conflict. A provider call begins only after a durable
`provider_started` fence. Started and settled evidence includes the exact
bundle identity and digest. Ambiguous failures settle as `outcome_unknown` and
are never blindly replayed. The operator surface offers **Reconcile**, which
creates a separately fenced observation; only a successful observation can
settle the original unknown operation, with a durable link between both IDs.

The first native provider is Kubernetes. It uses server-side apply for a
digest-pinned Deployment, Service, optional Ingress, and deny-by-default
NetworkPolicy. It allows in-cluster egress plus explicit target IPv4 CIDRs.
Observation records replica rollout, conditions, provider resource identity,
observed generation, and bundle drift. Retirement deletes only the exact
managed resources in reverse dependency order, treats an already-absent object
as success, preserves bundle/operation evidence, and clears the reachable URL.
The provider credential is decrypted just in time from a workspace Connection
and never appears in a plan, resource body, event, or response. Connected-machine
and managed-target contract variants are reserved and fail the current
provider-adapter plan check.

For a private/self-signed Kubernetes API, store the PEM certificate authority
in the same target Connection under `caCertificate` (the compatibility keys
`certificateAuthority` and `ca` are also accepted). It is bounded, supplied
only to Bun's per-request TLS verifier, and never projected into manifests,
plans, events, or responses. TLS verification is never disabled.

## API and authorization

Catalog reads require `workspace:read`; catalog and deployment changes require
`workspace:admin`. Native application sessions require `sessions:create` and
then use normal session permissions. The routes live under:

```text
/v1/workspaces/:workspaceId/internal-applications
/v1/workspaces/:workspaceId/internal-applications/:applicationId/build/sessions
/v1/workspaces/:workspaceId/internal-applications/:applicationId/events
/v1/workspaces/:workspaceId/internal-application-data-sources
/v1/workspaces/:workspaceId/internal-application-targets
/v1/workspaces/:workspaceId/internal-application-deployments
/v1/workspaces/:workspaceId/internal-application-deployments/:deploymentId/operations
/v1/workspaces/:workspaceId/internal-application-operations
```

The contracts are exported from `@opengeni/contracts/internal-applications` and
the public client/types from `@opengeni/sdk`.

## Trusted OCI publication

The repository includes `bun run internal-applications:publish -- <config.json>`
for the reference local/provider-native registry path. It requires Docker
Buildx and Syft, removes secret-like environment variables from build
subprocesses, builds and pushes for one declared architecture with BuildKit
provenance and SBOM attestations, independently generates an SPDX JSON SBOM,
hashes the exact SBOM and provenance evidence, constructs the versioned bundle
manifest, and registers it through the public API. The API key is read only
from the configured environment variable and never from the JSON file.

The SINTEF template is
[`bundle-publish.template.json`](../deploy/examples/internal-applications/sintef/bundle-publish.template.json).
Copy it outside version control, replace the UUIDs and paths, authenticate the
local registry through the normal Docker credential store, then run:

```bash
OPENGENI_API_KEY='<publisher key>' bun run internal-applications:publish -- ./bundle-publish.json
```

Promotion must reuse the registered digest; it must not rebuild the source for
each environment. Active and `previousBundleId` references are RESTRICT-fenced
in Postgres, so a referenced bundle cannot be deleted by retention cleanup.

## Enabling and rollback

1. Apply migration `0373_internal_applications.sql` with the normal rolling
   migration process.
2. Keep the feature flag false while creating cluster RBAC, workspace
   Connections, runtime/data Secrets, internal DNS/TLS, and the local model
   route.
3. Deploy API and web with the flag true, then verify `/v1/config/client` and
   the workspace Applications navigation.
4. Start with a development target and attached read-only data.
5. Disable the flag to remove the UI and API surface without deleting catalog,
   deployment, or audit state. Existing Kubernetes workloads are deliberately
   not destroyed by a flag rollback.

The reference SINTEF overlay and cluster prerequisites are in
[`deploy/examples/internal-applications/sintef`](../deploy/examples/internal-applications/sintef/README.md).
The reusable live provider check is
`bun run acceptance:internal-applications-kubernetes`; it is hard-fenced to an
explicit isolated kind context and covers private-CA TLS, apply, current
generation health, restart, update, rollback, drift, retire, and cleanup.

## Current preview boundary

The feature is ready for controlled, local Kubernetes demonstrations using
attached data. OpenGeni now owns the durable generation/test/preview session,
while the separately trusted reference publisher owns OCI construction,
registry push, SBOM, provenance, and digest production before bundle
registration. A deployer-specific lifecycle broker is still required to
perform clone/provision against the organization's chosen Postgres, S3,
document, or vector systems. Organization SSO at the generated app's Ingress,
GitOps/PR promotion, and automated OCI
retention/garbage collection remain separate provider integrations. Their
contract slots do not weaken the native Kubernetes path:
unsupported targets and missing credential references fail during plan review
rather than during an implicit deployment.
