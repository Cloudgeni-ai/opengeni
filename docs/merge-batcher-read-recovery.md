# Read failures and cycle outcomes

Repository GETs, artifact reads and explicit GraphQL queries retry transient 5xx,
rate limits and transport timeouts up to five attempts with exponential backoff
and jitter. Each request has a 60-second total budget and a 30-second attempt
timeout. A server-requested delay that cannot fit that budget defers the read;
it is never shortened to squeeze in another attempt. The existing complete
inventory deadline remains independently fail-closed. Permanent response
failures do not retry. Repository mutations and authentication token creation
are not routed through this read retry transport.

An exhausted read does not establish an unknown write. The one-cycle entrypoint
tracks actual Git pushes and REST submissions in its asynchronous execution
scope. Confirmed successful writes, definitive rejection and positive Git ref
reconciliation settle their respective attempts. Durable submitting, uncertain
or blocked effects conservatively prevent a deferred-read completion. Failure
to read reconciliation evidence does not settle a write.

Exit 75 is a versioned integration contract with the qualified supervisor: an
exhausted typed read with no unresolved current-cycle write or observed durable
effect. It is not a successful cycle, landing, or proof that earlier supervisor
uncertainty is resolved. A supervisor must never derive this permission from
stderr text alone, must preserve prior unknown outcomes and local process
timeout/signal uncertainty, and must retain failed-read diagnostics and retry
timing. Supervisors without this contract continue treating exit 75 as failure.

The GitHub provider offers no atomic cross-endpoint read snapshot. Current main,
candidate refs, exact tested tree, journal effects and PR state still require
their existing reconciliation and CAS checks; this change does not waive those
checks, cancel CI, reset effects, or retry a mutation.
