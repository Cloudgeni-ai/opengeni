# SINTEF local-data Site reference

This is the phase-one reference: one self-contained static SPA hosted by
OpenGeni, using the shared Site Runtime Gateway for durable AI over approved
local workspace knowledge. It creates no Deployment, Service, Function, Vercel
project, database, or API key Secret per Site.

## Data residence

- The exact Site HTML is an immutable workspace artifact in the deployment's
  configured object storage.
- Site/release/runtime evidence and durable session history stay in the local
  OpenGeni Postgres deployment.
- Representative research data stays in its system of record. Ingest approved
  evidence into local OpenGeni knowledge, or replace `memory_search` with a
  configured read-only local MCP adapter.
- The selected model name must route to the approved local inference endpoint
  when the demonstration requires a closed locality boundary.
- Connection and model credentials remain server-side. The Site iframe gets
  only an opaque page-lifetime `MessageChannel`.

## Facilitator runbook

1. Deploy the normal OpenGeni stack and apply [values.yaml](values.yaml). Keep
   Advanced Deployments disabled for this scenario.
2. Configure a local model route and index a small, non-sensitive approved
   materials evidence set in workspace knowledge. Verify ordinary OpenGeni
   `memory_search` can retrieve it for the demonstrating user.
3. Create a short-lived workspace API key for publication with
   `artifacts:publish`, `workspace:admin`, and `artifacts:read`. Put it only in
   the facilitator shell:

   ```bash
   export OPENGENI_SITES_PUBLISH_API_KEY='replace-at-run-time'
   ```

4. Copy `publish.template.json` to a temporary path outside version control.
   Replace the workspace UUID, operation UUID, API URL, and local model name.
5. From the repository root, publish:

   ```bash
   bun run sites:publish /path/to/publish.json
   ```

6. Open the returned `sitePath` on the OpenGeni web origin. Ask a question,
   observe the durable stream, inspect Site Usage and Activity, publish an
   updated artifact/release, then roll back. Archive only after the demo.
7. Restart API, web, and workers. Reopen the same stable Site route and verify
   the immutable release and session evidence remain available.

## Evidence checklist

- Save the Site release ID, artifact hash, manifest hash, runtime session ID,
  selected model, usage record, and the release/runtime Site events.
- Inspect page source and browser storage: there must be no OpenGeni key,
  provider key, integration credential, Variable Set value, or generic fetch
  endpoint.
- Capture egress/firewall or service-mesh logs covering browser -> OpenGeni,
  OpenGeni -> local data adapter/knowledge store, and OpenGeni -> local model.
  The exact commands depend on the enforcing network layer used by SINTEF.
- Revoke any selected Connection and confirm the next operation fails through
  ordinary OpenGeni authority checks while historical evidence remains.

The optional Kubernetes/full-stack scenario is intentionally separate under
[`deploy/examples/internal-applications/sintef`](../../internal-applications/sintef/README.md).
