# Post-build watchdog binding (prepared, not rollout clearance)

Use the qualified final image for both the batcher and watchdog. After the stopped
deployment and explicit health migration/activation binding are verified, prepare
a **new**, unconsumed admin plan. Never copy an old image's operator receipt or
fabricate a stopped/drained witness. The actual operator receipt must match the
new provider UID, image and URI; existing proof fields remain subject to real STOP
verification and are not granted authority by hydration.

Within that qualified image, with an authenticated workload identity and mounted
new admin directory containing the exact `plan/plan.json`:

```sh
bun /app/docs/merge-batcher-admin/watchdog-deployment.ts prepare CONFIG ADMIN_DIR ACTUAL_OPERATOR_RECEIPT
```

This command reads the actual Cloud Run service and writes only create-only local
seed files: `deployment-binding.json`, `operator-initial-receipt.json`,
`operator/deployment-receipt.json` and `stop-contract.json`. It requires manual0,
reconciled generation, final image/revision/configuration/activation and singleton
traffic. It uses the digest-pinned core module's versioned configuration projection,
not a second projection or an arbitrary old config hash. A partial local preparation
is not a usable seed and must not be retried over existing files.

`RuntimeConfig.operatorManifestDigest` is the SHA256 of the packaged
`/app/operator/source-manifest.json`, whose six packaged source hashes are checked.
The five STOP contract hashes are rebound to those packaged bytes, including the
workload-auth and limits substitutions. Archive the new directory through the
reviewed journal `archive` API and publish it to the configured seed object under
a retained immutable generation. Publishing, grants and activation require separate
review/go; the prepare command does none of them.

At execution, hydration verifies the pinned seed/current journal, original receipt
digest, full activation binding, source manifest, exact executable bytes and fresh
authenticated service read. It creates a private operator directory; the ordinary
OFF verifier rechecks its source hashes and deployment identity before execution.
STOP updates that private receipt, which is included in durable checkpoints.
Executable files are never loaded from the journal and are rehydrated from the
qualified image on restart. No writable image directory is required. Recovery
without a durable journal still holds; it never reconstructs a missing action
history from a seed. Final core pre-restoration and Manual checks remain mandatory.

## Required configuration and credentials

- Exact service/job resource names, shared final image digest, provider UID,
  generation, revision, versioned configDigest, activation, repository/state ref,
  phase caps, planDigest, bridge source digest and operator manifest digest.
- Dedicated bucket, config object and immutable generation, seed object/generation,
  activation-specific journal prefix; no placeholder IDs at execution.
- Dedicated watchdog service account and separate Scheduler invoker identity.
- Separate restoration GitHub App identity/install restricted to this repository:
  administration write, contents read, actions read and issues write, metadata read.
  Runtime App administration must remain read-only. The state-fence token uses its
  separately bound App/key and requests contents write only; that GitHub permission
  is repository-wide, not ref-scoped. Software and branch rules restrict its writes.
- Every App key reference is an existing numeric Secret Manager version, never
  plaintext, `latest`, a rotated shared token or a newly guessed App ID.
- A rollout-owner-selected existing GitHub issue/PR number in this repository is
  required as `incidentThread`, shared with the independent observer. No production
  destination has been established by this source work; fixture thread9 is not a
  deployment choice. The operator must confirm App comment access and marker authorship.

## Least-privilege grant plan (not applied)

Watchdog identity needs service read/update and operation read for the single
owned batcher, authenticated service invocation for status/drain, and execution
read for its own job (`run.services.get`, `run.services.update`, `run.operations.get`,
`run.routes.invoke`, `run.executions.get`). The reviewed operator writes a STOP version only to the
dedicated control secret. It needs access to the explicitly pinned App-key secrets,
not project-wide secret access (`secretmanager.versions.add` on the control secret;
`secretmanager.versions.access` on the App-key secrets). Runtime start is not an exposed watchdog action;
provider service-update/control-version permissions are broader than STOP and must
be constrained by reviewed code and resource bindings, not described as STOP-only IAM.

Bucket access: read on config/seed, read/create/delete on the dedicated journal
objects for generation-CAS replacement. Object overwrite requires both create and
delete (`storage.objects.get/create/delete`); do not give a misleading create-only role.
No bucket IAM administration. Scheduler needs `run.jobs.run`, not overrides/update/cancel. The independent sweep
needs execution/log reads and comment permission, not service update, control-secret
writes, rules administration or state writes. Resource-level bindings/conditions
and provider acceptance still require actual qualification before enable.

Permission references: [Cloud Run permissions](https://docs.cloud.google.com/run/docs/reference/iam/permissions),
[Cloud Run deployment/operation permissions](https://docs.cloud.google.com/run/docs/reference/iam/roles),
[Cloud Storage object replacement permissions](https://docs.cloud.google.com/storage/docs/access-control/iam-permissions).

No resources, grants, credentials, rules or runtime state are changed by this document.
Integrated independent review, final concrete values, workload-identity qualification,
independent missed-run alerts and deliberate kill/restart/unknown-outcome drills remain
required. ON is always deliberate.
