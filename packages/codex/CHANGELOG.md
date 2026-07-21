# @opengeni/codex

## 0.2.4

### Patch Changes

- 14ce2e3: Bound model-facing textual tool output with Codex-compatible, replay-idempotent semantics, account
  for complete current model input, make compaction failure/progress transitions
  durable and convergent, and replace recursive session discovery with a compact
  paginated projection.

## 0.2.3

### Patch Changes

- 6882ff2: Reuse the failed turn identity across database and workflow child-terminal producers so one failure cannot enqueue two parent updates. Bind the Codex subscription client header and compaction documentation to latest stable Codex CLI 0.144.5.

## 0.2.2

### Patch Changes

- ec508d4: Proactive context compaction now actually fires on the codex-subscription path: codex models declare their real (empirically measured) context window instead of inheriting the 1.05M global default, and the default compaction trigger moves from 60% to 90% of the declared window — compact as late as possible now that the window base is honest, with the reactive compact-on-reject ladder absorbing any overshoot.
- 58c78c6: Send a stable `session_id` header on every codex-subscription request. This is the backend's sticky prompt-cache-routing key: measured with byte-identical ~99k-token gpt-5.6-sol requests on one idle account, repeat requests WITHOUT the header hit the prompt cache only ~50% of the time (a per-request routing lottery across cache shards — matching the production fleet's 48.6% token-weighted hit rate), while WITH a stable session_id 10/10 requests hit at the 99.0% ceiling. Codex CLI always sends this header (its own last-3-days token-weighted rate on the same account is 94%); `prompt_cache_key` in the body only influences routing and does not pin it. The worker supplies the OpenGeni sessionId — the same value already used for `prompt_cache_key` — so routing and cache key agree, and the compaction summarizer (same request context) rides the same warm shard. Requests without a session context are unchanged.
- faf1487: Add workspace-local, holder-fenced Codex subscription leases with deterministic
  fairness across worker replicas, explicit allocator eligibility, and
  failure-classified same-turn failover. All-exhausted active goals now persist one
  generation- and policy-fenced capacity waiter, wake from authoritative reset
  timers or revisioned capacity mutations, survive Temporal restart and
  continue-as-new, and enqueue at most one normal continuation without synthetic
  user messages, full-turn replay, provider/model rewriting, or automatic
  entitlement redemption.

  Expose a generic accepted-turn policy-scope and per-scope unavailable-diagnostic
  seam for future named pools while resolving exact live/frozen same-turn reuse
  before membership filtering. Preserve manual versus policy pin semantics and
  session-sharded cache affinity without moving an in-flight lease or the legacy
  workspace pointer for policy homes.

## 0.2.1

### Patch Changes

- 5962dd0: Republish the closure so published manifests reference `@opengeni/contracts@^0.4.0`. The previous `^0.3.0` ranges exclude 0.4.0 under 0.x caret semantics, causing consumers to nest a stale contracts copy that lacks the current export surface.

## 0.2.0

### Minor Changes

- 2170732: Publish the full Stage C `@opengeni/*` runtime closure to npm so external hosts can consume OpenGeni from published packages instead of vendored workspace tarballs.

  The release pipeline now builds every publishable package, rewrites every published `workspace:*` dependency to a concrete semver range, rewrites source entry points to dist entry points for every publishable package, and leaves only leaf-only non-runtime packages ignored.
