# Release sentinel audit

`scripts/operator/release-sentinel-audit.ts` is a read-only, control-plane
command for auditing one synthetic release sentinel session after a worker
rollout. It exists so an external deployment operator can prove durable session
continuity without adding a public audit route or returning conversation
content.

`scripts/operator/release-sentinel-key-bootstrap.ts` is the matching
least-privilege identity bootstrap contract. It is intended only for a
protected external operator Job with normal database settings. It rotates the
named prior key when its one-time token is unavailable, creates a workspace
key with exactly `workspace:read`, `sessions:create`, `sessions:read`,
and `terminal:attach`, and writes the token only to the
operator-provided private output path. Its stdout contains IDs/counts but never
the token. The external operator must transfer the private file directly into
secret storage and delete the temporary Job/file; do not run it interactively
or upload its private output as evidence. The helper creates the output with an
exclusive no-follow open and verifies it is a regular file with mode `0600`
before returning; an existing path or symlink is a hard failure.

Run it inside the reviewed API image, where the normal database settings are
already injected:

```bash
bun run operator:release-sentinel-audit -- \
  --workspace-id <sentinel-workspace-uuid> \
  --session-id <sentinel-session-uuid> \
  --client-event-id release-sentinel:<stable-operation-key>:turn:v1
```

The command reads the exact workspace-scoped session, events, turns, and
conversation-history rows through existing `@opengeni/db` RLS helpers. It emits
only target IDs and counts. It never emits event payloads, model text, tool
arguments/output, history items, credentials, connection details, or upstream
error text.

The result fails unless it finds:

- the expected create idempotency key and one matching client event;
- one logical completed turn, with every significant model/tool/terminal event
  bound to that turn and no significant event attributed to another turn;
- an exact trigger chain from the one client event to the original
  `turn.started`, then to one `turn.preempted{reason:"worker_shutdown",
  resumeWithNotice:true}`, then to the resumed `turn.started` and the final
  turn row; ordering must prove the tool started before preemption and its
  output completed only after resume;
- exactly one `exec_command` creation and one matching tool output/side effect
  across those attempts;
- exactly one original sentinel user-history item;
- exactly one matching history tool-call/output pair for the same call ID;
- at least one model-usage effect, with a non-empty idempotency `sourceKey` on
  every effect, and no duplicate history call IDs, model-usage source keys, or
  tool-output IDs;
- no model/tool/message effects after the logical turn completed.

This command proves the durable database half of a release sentinel. The
external operator must separately verify authenticated/public API health,
Postgres/NATS/Temporal readiness, the sandbox marker side effect, workload image
digests, and error-budget gates. It must not use this command to claim that an
in-product agent can recover a fully unavailable platform.