# Dependency Upgrade Log

**Date:** 2026-07-14 (updated 2026-08-08)
**Project:** OpenGeni  
**Language:** TypeScript  
**Manifests:** `package.json`, `packages/runtime/package.json`,
`packages/testing/package.json`, `apps/worker/package.json`

## Summary

This log covers every dependency changed during the session-control clean
cutover. Direct packages were updated within their declared stable ranges, and
the root resolution contract now pins patched transitive releases so production
does not ship advisories hidden behind older dependency trees.

## Updates

### OpenAI Agents JS: 0.13.3 → 0.14.3

- Upgraded every direct `@openai/agents`, `@openai/agents-core`, and
  `@openai/agents-extensions` declaration together. The resolved
  `@openai/agents-openai` and `@openai/agents-realtime` packages are also
  0.14.3; the runtime keeps the compatible OpenAI client at 6.47.0.
- Rebased OpenGeni's exact-resume sandbox patch without widening it: Blaxel,
  Daytona, E2B, and Runloop still expose `resumeExact()` and never silently
  replace a missing provider sandbox on that path.
- Upstream source: `openai/openai-agents-js` tag `v0.14.3`, commit
  `94a3edc3e5318fdbc4ceb045df4dad934ca4ab2b`.
- Re-ran the provider fault matrix after the upgrade. The release fixes several
  stream-usage, cancellation, refusal, tool-identity, and session-transaction
  defects, but it does not remove the runner's repeated full-history clones or
  validate every Responses terminal failure shape. Those remain application
  hardening work, not assumptions attributed to the dependency upgrade.

### OpenAI Agents JS: 0.11.6 → 0.13.3

- Bound all direct `@openai/agents`, `@openai/agents-core`, and
  `@openai/agents-extensions` declarations to the same latest stable release.
- The relevant upstream fix is the Modal adapter's use of
  `sandboxes.create(..., { command: ["sleep", "infinity"] })`. Version 0.11.6
  attempted an optional `Image.cmd()` call that Modal JS 0.7.4 did not expose,
  so registry images whose default command exited produced unusable sandboxes.
- Upstream source: `openai/openai-agents-js` tag `v0.13.3`, commit
  `7833c50d6bb9ca1d63a43c84b330c46d024b1cfd`.

### Modal JS: 0.7.4 → 0.9.0

- Pinned Modal 0.9.0 globally so the Agents Extensions adapter and OpenGeni's
  direct lifecycle operators cannot resolve different SDK implementations.
- Modal 0.8 changed native snapshot calls to options objects and changed both
  snapshot kinds to a 30-day default Image lifetime. OpenGeni's adapter
  translates the still-positional Agents Extensions 0.13.3 call, passes the
  configured timeout through the new API, and explicitly sends `ttlMs: null`.
  The provider-bound checkpoint artifact ledger—not an implicit provider
  expiry—owns safe deletion after an Image is no longer current or previous.
- The bridge verifies the active SDK reports exactly 0.9.0 and fails closed on
  an incompatible adapter/session shape. It rebinds after filesystem restore,
  which replaces the provider sandbox inside the long-lived session.
- Upstream source: `modal-labs/modal-client` tag `js/v0.9.0`, commit
  `77d609d2fabac3829df7e82cb57b120a383d0512`.
- Earlier scheduling evidence remains distinct: a pending `SandboxGetTaskId`
  was provider capacity pressure, not fixed by this API upgrade.

### OpenAI Node: 6.36.0 → 6.47.0

- Aligned OpenGeni's direct runtime dependency with the current client required
  by Agents JS 0.13.3. Keeping 6.36.0 installed a second `OpenAI` class whose
  private identity was incompatible with the Agents SDK's 6.47.0 types.
- The upstream changelog from 6.37.0 through 6.47.0 contains additive API work
  and bug fixes; no OpenGeni call-site migration was required.

### Compatible workspace updates

- Temporal JS `1.17.0` → `1.20.2`.
- Playwright `1.59.1` → `1.61.1`.
- `@types/bun` `1.3.13` → `1.3.14`.
- `@codemirror/view` `6.43.1` → `6.43.6` and
  `@uiw/react-codemirror` `4.25.10` → `4.25.11`.
- Changesets CLI `2.27.11` → `2.31.0`.

### Patched transitive security floor

The root override map binds the dependency graph to patched stable releases of
`@grpc/grpc-js`, `dompurify`, `esbuild`, `form-data`, `hono`, `ip-address`,
`js-yaml`, `mermaid`, `protobufjs`, `qs`, `uuid`, `vite`, and `ws`. This reduced
`bun audit` from 45 advisories (12 high) to zero.

## Validation

- [x] OpenAI Agents JS 0.14.3 frozen install and dependency-tree convergence
- [x] Typecheck (23 projects)
- [x] Full suite after rebasing the provider-neutral image-generation release
  (6,743 passed, 29 explicitly gated live-service tests skipped, 0 failed,
  37,287 assertions across 638 files)
- [x] Focused provider/recovery/worker/deployment suite (628 passed, 0 failed)
- [x] Native Linux API and worker image builds
- [x] Deterministic model-input, process-RSS, long-turn, and observability-series
  memory gates: 16.17x lower model-input peak delta for an identical 8,000-item
  wire history; 33.8% lower long-turn peak delta and 46.0% lower settled delta
  with an identical 17.7 MB wire fingerprint and no slowdown; 18.9–27.0%
  process-bundle RSS reduction; 3.86x projected Prometheus head-series reduction
  with all application metrics retained
- [x] Minimal ad-hoc live Codex-subscription, Azure Responses, Fireworks Chat,
  and pinned Kimi Gateway probes
- [x] Typecheck (19 projects)
- [x] Provider unit tests
- [x] Full real-database suite (2,953 passed, 3 explicitly gated live-service
  tests skipped, 0 failed)
- [x] Dependency audit (0 vulnerabilities)
- [ ] Production Codex-subscription canary and post-cutover continuity proof

The zero-advisory result above is the 2026-07-14 release receipt. On 2026-08-08,
`bun audit` reported 37 advisories in pre-existing unrelated dependency paths.
The advisory IDs and severities are identical to current `origin/main`; this
upgrade introduced none. Those updates require their own compatibility review
and are not silently bundled into this runtime cutover.

## Commands

```bash
bun install
bun run typecheck
bun test packages/runtime/test/sandbox-provider-registry.test.ts
bun test apps/api/test/sandbox-resume-modal-smoke.test.ts
OPENGENI_REQUIRE_REAL_SERVICES=1 bun test --max-concurrency 6 --timeout 30000
bun audit
```
