# Azure Container Apps

The `azure-container-apps` deployment profile runs OpenGeni without AKS or Helm.
Its Terraform root is [`deploy/terraform/azure-container-apps`](../deploy/terraform/azure-container-apps).
The profile and root are separate from `azure-managed`, which remains the AKS
reference. The Terraform root README is authoritative for variable and output
names; render the current operator plan before applying:

```bash
bun run deployment:preflight -- --profile azure-container-apps --json
bun run deployment:stack -- --profile azure-container-apps
```

For a registry owned by this root, render the plan with `--create-acr` (or
`OPENGENI_ACA_CREATE_ACR=true`). The plan then includes foundation, explicit image
import and digest readback, and bootstrap in that order. Merely setting an image
reference to an empty registry does not populate it.

## Architecture and ownership

- One dedicated resource group owns the Container Apps environment, networking,
  private PostgreSQL Flexible Server, Blob storage, Key Vault, identities,
  application workloads, and capped Log Analytics retention. Azure also creates
  a separately named infrastructure resource group for the ACA environment;
  verify that group is removed during teardown.
- API and web use internal HTTP ingress. An environment-level `httpRouteConfigs`
  resource provides a single HTTPS origin with API paths routed to API and other
  paths to the stock console. Workers are never public routing targets.
- Control and turn workers are separate continuously running apps. HTTP scale
  rules cannot wake Temporal pollers: each worker needs at least one replica.
- Temporal and Core NATS are separately operated dependencies. Provide endpoints
  reachable from the ACA network and their authentication/TLS configuration.
  A singleton fixture or Temporal development server is not a production HA
  service. Do not silently deploy either as a production default.
- Use Azure Blob storage with browser CORS restricted to the deployment's exact
  HTTPS origin. This root does not configure additional embedding origins or
  custom domains.
- Use a remote sandbox such as Modal. ACA neither exposes a Docker host socket
  nor makes its application replica a durable user workspace.
  The API and workers fix `OPENGENI_SANDBOX_OWNERSHIP_ENABLED=true` so sandbox
  execution and file publication use the holder-fenced ownership path. This
  setting cannot be overridden through the generic environment maps.

The API/web images must be compatible with one another and with the migration,
worker, and outbox images. Prefer one release BOM with immutable image digests.
The sandbox image runs at the sandbox provider, not in the ACA environment.
The default images must be anonymously pullable. With `create_acr=true`, identities
receive pull access only to the registry created by this root; populate that
registry before creating the migration job. Pull access to another private
registry is not configured. Model, sandbox, database, and product access secrets
must not be put in source-controlled configuration.

The default `configured` product mode uses the deployment shared key as its
access boundary. With no explicit `OPENGENI_DELEGATION_SECRET`, the shared key
can bootstrap the configured actor. Setting a separate delegation secret
requires a host-signed product token for that actor; a deployment key alone is
not a product identity in that posture. The client advertises `configuredToken`
in either case, so verify actual authenticated access rather than guessing the
posture from that label. `managed` access has additional identity, email, and
signing prerequisites and is not implied by the default profile.

An explicit delegation secret must reach API, control, and turn roles and meet
this module's trimmed 32-character minimum. Place OTLP authorization headers in
`secret_env`, not `config_env`; the latter rejects known header settings and
inline model-provider `apiKey` fields. Prefer `apiKeyEnv` for model JSON. Put any
other credential-bearing JSON in `secret_env` explicitly: these checks are not
a general-purpose secret detector. Never commit the private variable file.

## Bootstrap and activation

1. Choose the resource group, region, names, external service endpoints, matching
   image digests, exact browser origins, and intended product access posture.
   Keep Terraform state, plans, generated environment files, and secret values
   in private operator storage, outside the repository. Sensitive Terraform
   values are still present in state; protect the backend accordingly.
2. Initialize, validate, inspect a saved plan, and apply the bootstrap phase.
   Keep application creation disabled. When creating an empty ACR, first apply
   `deployment_phase=foundation`, import the matching digest-pinned images into
   that registry, update the private image references, then apply `bootstrap`.
   Azure validates image pulls when creating the job, not only when starting it.
   The manual migration job receives database-owner/provisioning credentials;
   ordinary app replicas must not.
3. Start one migration execution, with parallelism and completion count one and
   retries zero. It runs schema migrations, provisions restricted runtime roles,
   asserts runtime posture, and imports the deployment catalogs. Wait for the
   exact execution to reach `Succeeded`; starting the job is not migration proof.
4. Initialize Temporal schemas/namespace through the external service's own
   operator procedure. Confirm NATS authentication and private reachability.
5. After observing the exact successful execution, set
   `migration_completed_revision` to the exact `migration_job.image` reference
   and `deployment_phase=apps`. This is an operator attestation, not a Terraform
   query of execution history. Review the application plan. API, control/turn
   workers, and the dedicated outbox dispatcher use their role-correct secrets.
6. Verify readiness and run conformance with the actual remote sandbox and model.

Never use `terraform -target` to bypass bootstrap gates. On an existing database,
follow [the deployment maintenance procedure](deployment.md#database-identities-and-runtime-posture):
stop every writer, include all runtime login roles in the migration role list,
and only reactivate applications after migrations and posture checks succeed.
An old successful bootstrap execution is not proof that a later release's
migrations ran.

## Verification

The generated ACA operator plan includes its endpoint and conformance commands.
Select a real remote sandbox explicitly; the generic conformance script defaults
to `none`. Keep deployment shared-key or product tokens in environment variables,
not command arguments or retained logs.

Generated preflight preserves the accepted product/access modes and public URL.
For a direct managed-mode environment check, supply the paired selectors
`--product-access-mode managed --access-mode externalGateway` and
`--public-base-url "$OPENGENI_PUBLIC_BASE_URL"`; omit them for the default
configured/shared-key profile. This checks the contract's environment requirements,
not real managed login or gateway authorization.

The generic script's random browser origin is unsuitable for this root's exact
Blob CORS policy. Use the actual edge origin and opt into foreign-origin denial;
select a funded model explicitly when the default model is not configured:

```bash
bun run deployment:conformance -- --base-url "$OPENGENI_CONFORMANCE_BASE_URL" \
  --sandbox-backend modal --model "$OPENGENI_CONFORMANCE_MODEL" \
  --browser-origin "$OPENGENI_CONFORMANCE_BASE_URL" \
  --deny-foreign-browser-origin --skip-observability --json
bun scripts/deployment-aca-observability.ts \
  --terraform-root deploy/terraform/azure-container-apps
```

Run the private helper with the initialized backend, its `TF_DATA_DIR`, and the
authenticated Azure CLI environment used for deployment. The helper requires
Linux/WSL2 and util-linux `script` for bounded terminal-backed Azure exec; a BSD
or macOS `script` implementation is not interchangeable. It reads API request
metrics on the private listener and verifies the module's actual metrics-auth
posture, then reads control/turn metrics plus
health/readiness through Azure exec. It requires nonce-bound evidence and does
not interpret CLI exit code zero alone as success. Public metrics are deliberately
skipped in the generic runner; the private check is separate and required.
Log Analytics retains application logs. Delivery to an external OTLP collector
and downstream ingestion of metrics or traces require their own acceptance
checks; this helper does not prove them.

Static Terraform tests prove configuration properties, not an operational
deployment. Live acceptance must cover:

- HTTPS same-origin console/API routing, unauthenticated rejection, and
  cross-workspace access denial.
- Database TLS, required extensions, restricted runtime identities, migration
  completion, and successful polling by both Temporal worker roles.
- A real model turn that invokes sandbox tools, persists a file, and reads it
  again on a follow-up; merely selecting the backend is not execution proof.
- Scheduled-task dispatch, Blob upload/download, and browser upload CORS.
- At least ten minutes of SSE observation, disconnect/reconnect and durable
  cursor replay, an API revision replacement, and recovery after NATS disruption.
  ACA's default ingress documents a 240-second request timeout; test the actual
  stream/reconnect contract instead of assuming an unlimited connection.
- Graceful worker replacement during an active turn: preserve the logical turn
  and recover under a new fenced attempt without replaying an ambiguous mutation.
- Retained application logs and private metrics. Do not expose `/metrics` through
  the public routing resource merely to satisfy the generic conformance probe.

## Native export boundary

Editable document/spreadsheet/presentation storage and native file export are
different capabilities. Production export requires the dedicated materializer's
unchanged Linux launcher to prove network-namespace denial, read-only mounts,
scratch isolation, and process resource limits using `bwrap` and `prlimit`.
Never enable unsandboxed development materialization on an ACA replica.

This root fixes `OPENGENI_ARTIFACT_MATERIALIZER_DEPLOYED=false` and
`OPENGENI_SANDBOX_ARTIFACT_RUNTIME_ENABLED=false`; there is no
operator assertion or activation input. A live probe on the tested ACA
Consumption environment failed because unprivileged namespace creation was
denied. Native document, spreadsheet, and presentation exports are therefore
unsupported by this profile. Supporting a separately operated, namespace-capable
materializer requires additional runtime/IaC integration and an end-to-end export
test; changing the flag alone is not supported. An export-disabled installation
is not feature-complete.

## Teardown

Stop new test sessions/schedules and terminate only the sandbox instances created
by this deployment. Destroy application resources and any separately owned
dependency fixtures, then destroy the substrate using its original state and
variables. Inspect the exact resource group and registry afterward; a successful
CLI exit alone is not an inventory check. Include the Azure-managed infrastructure
resource group. Follow Azure's retained-secret policy for soft-deleted Key Vaults,
without touching unrelated vaults or resources. Purge protection is enabled by
default; temporary tests may explicitly disable it before creation and purge
only their own soft-deleted vault after destruction.

For temporary validation, keep an explicit resource manifest and finish by
confirming that every created Azure resource and public endpoint is absent.
Do not delete resources adopted from an existing deployment.