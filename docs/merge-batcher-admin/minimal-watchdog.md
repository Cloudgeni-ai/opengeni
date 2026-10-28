# Minimal provider watchdog — alert-only policy

## Current behavior

The watchdog is a read-only monitor. It never invokes STOP/OFF, acquires or
resumes an OFF claim, changes rules or readiness, or releases/disarms native
auto-merge. The provider has no control-action callbacks. Historical claims,
locks, journals, receipts and rollback materials remain untouched.

Every event includes `policy: "alert-only/v1"`, `outcome` and `severity`.
Healthy observations emit `healthy`/INFO. Status, progress, binding and provider
failures emit `held`/WARNING and exit 1, except during valid pinned grace:
then they emit `suppressed`/INFO with the original reason and `suppressedUntil`,
and exit 0. Suppression is not a healthy observation. Image-entrypoint and
provider failure paths use the same event policy.

`graceUntil` is an optional Unix-millisecond deadline pinned by the rollout owner
after a deployment or control-plane landing. It must be a nonnegative safe integer
no more than 30 minutes ahead of the configuration-load clock. Expired deadlines
are valid but suppress nothing. Invalid values emit an unsuppressed
`invalid-grace` WARNING and are ignored; they neither mute alerts nor prevent a
healthy status check. The bound is checked against each execution's clock: a
deadline pinned too far ahead becomes valid during its final 30 minutes. Rollout
owners must pin a deadline within the horizon when configuring it, rather than
rely on an initially invalid value remaining invalid. Ticks never renew grace.
The immutable config digest is
verified before its grace can suppress any image-validation failure.

Grace deliberately suppresses *all* health reasons, including an explicit stop,
crash loop, unavailability and deployment binding mismatch, as well as integrity
failures in the plan, source hashes or contract digest. Those reasons remain
visible in INFO events. Use a short explicit deadline; never use grace to mask
incompatible runtime scheduling. Missing-run monitoring remains independent.

## Observation and binding

Cloud Scheduler invokes the existing Cloud Run Job on its configured five-minute
UTC schedule. Keep one task, parallelism one and retries zero. The provider uses
the retained cloud-auth module for authenticated read access and a 15-second
`/status` timeout. It validates the retained plan, source hashes and exact service
UID, URI, image digest and reconciled generation before reading status. A mismatch
alerts, including after grace expires; it does not invoke recovery.

Before a later batcher deploy, the rollout owner must first pin bounded grace in
a watchdog Job update. After the batcher deploy, **re-pin the deployment contract
and configuration digest in a second Job update**, including the new image digest.
Grace alone cannot repair an obsolete binding. Keep all prior receipts
and configuration versions as historical evidence. Legacy claim fields identify
that historical configuration; the watchdog does not access claim storage.

Stopped/draining states, three consecutive unclassified failures, or a control
observation at least 900 seconds old produce an alert reason. Successful idle and
Batch-wait cycles count as progress. Without a successful cycle, startup has
120 seconds from immutable `runtimeStartedAt`; otherwise progress expires after
900 seconds. A cycle begun before expiry can finish within its fixed deadline;
later cycles, heartbeats and observation deferrals never renew it. Invalid,
future, malformed or unavailable measurements alert rather than imply health.

## Ordered no-Manual deployment and verification

Coordinate with the designated batcher owner. This change authorizes no batcher mode
switch, CI cancellation/rerun, readiness edit or OFF drill.

1. Complete exact-head VM validation and independent review; attach evidence and
   land through `queue-ready`. Build and qualify the immutable image from landed
   source, retaining its source manifest, digest and test output. Arrange rollout
   promptly after landing: the old Job retains automatic-OFF behavior until the
   in-place image/configuration update below is complete.
2. Capture the current Job, Scheduler, binding and alert-routing configuration.
   Confirm no Job execution is running immediately before the update. If one is
   running, let it finish and check again; do not cancel it or pause Scheduler.
3. Update the watchdog Job in place without pausing Scheduler or changing batcher
   mode. Publish the image and pinned configuration/digest in the same Job update
   so an execution cannot observe a mixed revision. Include exact current runtime
   binding and a fixed `graceUntil` no more than 30 minutes ahead.
4. Read back the Job image and configuration digest and confirm Scheduler remains
   enabled. Verify the next **genuine scheduled execution**, not only a manual
   invocation: retain execution identity, timestamps, output and exit status,
   including `policy: "alert-only/v1"` on every event.
5. Verify alert routing for normal and failure-path events: unsuppressed WARNING
   events page; suppressed INFO events do not page or produce Job-failure alerts.
   Test fixtures may exercise failures without modifying live batcher health.
   Keep absence-of-executions monitoring separate. Do not claim deployment success
   until actual output and routing are verified.
6. Confirm App-only ON, unchanged runtime settings, native auto-merge state and
   historical evidence. Report landed SHA, image digest and deployment UTC time.

The Job needs read access to its retained configuration and authenticated target,
plus logging. It no longer needs ruleset-write or claim-write credentials for this
watchdog. Inventory existing bindings with the owner; do not rotate credentials
or remove shared operator access as an incidental deployment step.

## Historical operator evidence

Earlier revisions of this document described automatic OFF and stopped-lineage
recovery. Those are historical records, **not current watchdog policy or rollout
instructions**. The separate operator and its retained STOP/drain receipts are
unchanged by this patch. Never replay an old STOP, delete a claim, rewrite a
journal or infer permission for Manual from this monitor's output. Any separately
authorized operator operation remains the owning coordinator's responsibility.
