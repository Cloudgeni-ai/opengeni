# Workbench production acceptance

This document defines both the executable release gate and the broader product
readiness program for the generic OpenGeni workbench: the
Changes, Files, editor, Terminal, Desktop, capture-backed cold path, and live
sandbox reconciliation exposed by `@opengeni/react` and consumed by the
first-party web app. It applies equally to the standalone product and embedded
hosts. Integration instructions live in [`embedding-workbench.md`](embedding-workbench.md);
this document keeps candidate evidence distinct from readiness work that is
periodic or change-triggered.

## 1. Definition of done

An individual release is publishable only when all of these statements are
true at the same time:

1. There are **zero known defects** in the release scope.
2. Every row in
   [`workbench-acceptance-contract.ts`](../scripts/workbench-acceptance-contract.ts)
   is backed by the exact deployed live receipt. The larger matrices below are
   a readiness backlog and regression design, not assertions to manufacture in
   every candidate bundle.
3. Every required check ran against the exact immutable artifact being
   promoted. A mock, demo, local build, different commit, rebuilt image, or
   older staging receipt is not equivalent evidence.
4. The authenticated deployed product passed with a real sandbox and real
   object storage. Unit, component, and browser tests are necessary but cannot
   substitute for that live proof.
5. Desktop and mobile Chromium surfaces passed separately; staging additionally
   proved the real desktop framebuffer.
6. No required test was skipped, quarantined, retried into green, or allowed to
   fail. A flaky required test is a product defect.
7. The evidence bundle is complete, machine-readable, sanitized, and retained
   with the release. Missing evidence fails closed.

It is impossible to prove that unknown defects do not exist. OpenGeni therefore
uses the strongest executable equivalent for each candidate: zero known
defects, deterministic release gates, the complete authenticated live harness,
100 capture/navigation/cancellation observations, and a failure-free live
soak. Scheduled real-device and exploratory reviews remain readiness evidence
and must never be represented as candidate-specific results unless a workflow
actually ran them. Passing means the evidence proves the claims; it never means
reviewers failed to notice a problem.

## 2. Evidence integrity

Every live evidence bundle MUST bind:

- full 40-character OpenGeni source SHA;
- the canonical release-candidate workflow run and its unexpired immutable
  Actions artifact identity/digest (the release workflow derives the download
  URL from the validated artifact ID; dispatchers cannot choose a URL or hash);
- API, worker, web, relay, and stock headless-sandbox image digests, with
  migrations explicitly aliased to the API manifest;
- package versions and package tarball integrity hashes;
- the candidate Helm chart version, exact packaged-byte SHA-256, and immutable
  chart artifact; the final BOM additionally binds the official OCI reference
  and manifest digest created from those accepted bytes;
- deployment environment and workflow run URL;
- browser name/version, operating system, viewport, device scale factor, input
  modality, color scheme, contrast preference, and reduced-motion preference;
- test-fixture revision and deterministic seed;
- account/workspace/session identities for the dedicated canary only;
- capture revision, lease epoch, sandbox backend, and sandbox identity;
- per-step wall-clock timings and performance traces;
- screenshots for the live desktop/mobile states exercised by the candidate;
- accessibility reports, console/page errors, failed network requests, and
  unhandled rejections;
- explicit pass/fail for every machine-readable candidate row, with no implicit
  default.

Evidence MUST NOT contain raw credentials, cookies, signed object URLs,
kubeconfigs, customer data, conversation content outside the deterministic
fixture, or unredacted provider responses.

The manually dispatched release-candidate workflow accepts the exact package
plan (which is empty for an application-only release), takes the product release
version from the source-controlled Helm chart rather than inferring it from an
unrelated npm package version, requires the current versioned `main` SHA with no
pending changesets,
builds each physical image at most once under a full-SHA candidate tag, and
publishes an immutable `opengeni-candidate-<sourceSha>` receipt. A retry reuses
an already-present manifest instead of rebuilding it. Image and chart
repositories derive from the validated `OPENGENI_RELEASE_OCI_PREFIX`; the
portable login boundary supports built-in GitHub auth or short-lived Azure
OIDC and always drops registry credentials before the anonymous-pull proof.

The protected `release-acceptance.yml` workflow is the canonical acceptance
producer. Its protected environment pins the trusted operator repository and
workflow path and supplies the narrow credential required to read that private
run's artifact. The workflow takes an operator run ID—not an evidence URL or
hash—then verifies the successful main-branch workflow identity, current-main
ancestry, exact source-named artifact ownership, expiry, and provider digest.
It imports only the sanitized bundle and sidecar, replaces candidate and public
producer authority with independently verified OpenGeni metadata, and validates
the complete schema-v2 bundle before it can emit the canonical
`release-acceptance-<sourceSha>` artifact. The pre-publication release workflow
accepts only the candidate and acceptance workflow run IDs, resolves their
canonical artifacts through the GitHub API, verifies the provider artifact digests, and validates the bundle against
[`scripts/workbench-acceptance-contract.ts`](../scripts/workbench-acceptance-contract.ts).
The validator rejects a missing live environment/requirement pair, retries, skips,
known defects, changed/missing/extra image roles, a migration digest that does
not equal the API digest, candidate/staging/production drift, sub-budget
performance evidence, a canary window shorter than 72 hours, and secret-bearing
evidence. A checkbox or prose summary is never accepted in place of the parsed
bundle. It deliberately does not accept invented real-device or visual-polish
rows.

Staging and production evidence MUST identify the same source SHA, source tree,
image digests, chart version, and chart byte hash as the candidate receipt. The
final release job is gated by the protected `production-release` environment. It compares the
existing immutable BOM before creating any version, full-SHA, or `latest` alias;
any mismatch stops with no alias mutation. It then verifies every alias and the
anonymous OCI chart pull against the candidate bytes and writes the resulting
official chart manifest identity into the BOM. It never rebuilds images or
repackages the chart after acceptance.

## 3. Dedicated live fixture

Live verification uses a disposable, operator-owned canary account and
workspace containing no customer data. The canary has:

- a dedicated, bounded model billing identity that does not depend on manual
  credit grants or a customer's balance;
- least-privilege credentials whose workspace and permissions are verified
  through `/v1/access/me` before any mutation;
- one deterministic repository fixture with an ordinary repository, deeply
  nested repository, linked worktree marker, ignored dependency/build residue,
  Unicode paths, binary content, symlink, executable, rename, deletion,
  untracked file, staged file, and unstaged file;
- deterministic file contents and expected hashes;
- explicit cleanup ownership and an expiry;
- no shared sandbox, session, object prefix, or credential with customer work.

Credential/workspace drift, insufficient permissions, unavailable model
capacity, exhausted billing, missing storage, or an unhealthy sandbox MUST fail
preflight before a release or observability workflow mutates infrastructure.

## 4. Product-readiness functional matrix

Every row below is part of product readiness and regression design. The
per-candidate subset is the machine-readable contract; other rows run when the
affected surface changes and during scheduled readiness reviews.

| Area | Required proof |
| --- | --- |
| Capture cold path | A completed file-changing turn commits a capture; a fresh browser with no live box paints the correct tree, Changes summary, diff, and touched-file content from that capture. |
| Capture absence | A session with no capture shows an honest loading/fallback state and warms only when live data is required; it never renders an authoritative empty tree. |
| Degraded capture | Repository-discovery failure or timeout publishes the typed degraded revision and prefers live data; the previous capture is not presented as current. |
| Capture URL expiry | Expired signed manifest/content URLs are refreshed or surfaced as actionable retry states; no infinite spinner or stale content. |
| Files tree | Expand/collapse, keyboard navigation, selection, scrolling, path breadcrumbs, refresh, truncation disclosure, and empty directories remain correct. |
| File metadata | Binary, deleted, renamed, executable, symlink, truncated, too-large, and modified badges never survive after the authoritative state clears them. |
| Editor | Open, edit, save, optimistic state, server confirmation, conflict, rejection, retry, read-only, and session switch during save are correct. |
| Changes | Repository grouping, staged/unstaged/untracked/deleted/renamed files, additions/deletions, same-shape changed hunks, binary diffs, and clean-state reset are correct. |
| Terminal | Open, input, output, resize, reconnect, command failure, large burst, multiple terminals, detach, session switch, and teardown are correct. |
| Desktop | Capability negotiation, unavailable state, connect, reconnect, resize, focus, keyboard/pointer input, reduced motion, and teardown are correct when supported. |
| Machine state | Cold, warming, live, hibernated, offline, reconnecting, consent-required, degraded, and failed states are truthful and timestamped. |
| Default tab | Pre-paint selection uses current-session evidence. There is no post-render tab flip. Explicit host selection wins. |
| Host tabs | Leading/trailing tabs preserve ordering, selection, accessibility, and session isolation. |
| Collapse/resize | Controlled and uncontrolled collapse, panel resize, min/max constraints, persistence, narrow viewport, and orientation change are correct. |
| Notifications | Errors are deduplicated, actionable, host-routed, non-secret, and scoped to the current session. |
| Steer/Pause cancellation | A committed control is never lost: the old attempt is durably fenced, every unresolved side-effecting tool call is closed as `interrupted / outcome unknown`, and physical activity shutdown completes before the replacement starts. Exercise model streaming; credential/environment loading; context compaction; MCP connection; an INT/TERM-resistant terminal process; repository clone, rig setup, file materialization, token seeding, and in-flight credential refresh; turn-end capture; warm snapshot; eager and lazy sandbox provisioning; recording teardown; and MCP teardown. Test cloud PTY, local PTY, and connected-machine OpCancel paths. A Steer waiting on that fence renders `Stopping previous attempt…` with its durable queued prompt; it never looks like ordinary capacity queueing. No late capture, event, output, file mutation, lease, or provider result from the predecessor becomes authoritative. |

## 5. Identity and race matrix

The following invariant has no tolerance: after the workbench identity changes,
content from the previous identity may appear for **zero rendered frames**.

Exercise every transition with the old request unresolved, resolving both
before and after the new request:

- session A → session B → session A;
- workspace A → workspace B with identical session identifiers in the fixture;
- authenticated subject A → sign-out → subject B;
- capture request, signed-manifest request, capture-file request, root tree
  request, expanded-directory request, git status, diff, event replay, sandbox
  capability request, sandbox prewarm, editor save, and terminal connection;
- debounce timers, optimistic overlays, default-tab latches, selected-tab
  latches, warm intents, provision edges, degraded notifications, and retry
  callbacks;
- component unmount/remount and React Strict Mode double invocation;
- abort before headers, during body read, after successful response, and after
  identity generation changes;
- response order permutations for parallel directory, diff, and event requests.

Required assertions:

- zero stale DOM frames;
- zero stale notifications;
- zero request continuation without the current identity/generation fence;
- zero cross-session cache keys;
- zero terminal bytes or editor mutations delivered to the wrong session;
- zero sensitive content retained after sign-out or workspace change.

Timing-sensitive automated cases must pass their configured repetition/property
suite. The live per-candidate gate performs 100 capture/navigation observations
and 100 real Steer cancellations plus a hostile Pause; broader state-machine
coverage runs in protected source CI.

## 6. Scale and boundary matrix

Each boundary is tested at below, exactly at, and above the product limit. Above
the limit MUST produce bounded, truthful degradation rather than a crash,
silent omission, or unbounded resource use.

- tree: empty, one entry, 1,000, 10,000, and 100,000 entries;
- path: root, deep nesting, Unicode normalization variants, spaces, shell
  metacharacters, maximum supported component length, and traversal attempts;
- repositories: none, one, many, deeply nested, linked worktree, submodule,
  vanished during discovery, discovery timeout, and repository-count guard;
- files: empty, inline-content boundary, signed-content boundary, too-large,
  binary, invalid UTF-8, long lines, mixed line endings, and file replaced while
  loading;
- diffs: empty, metadata-only, one hunk, many hunks, same line counts with
  changed text, large generated diff, rename-only, mode-only, and binary;
- terminal: empty output, sustained output, burst output, long lines, ANSI/OSC
  sequences, Unicode, resize storm, reconnect storm, and backpressure;
- events: empty replay, sequence gaps, duplicate delivery, reconnect, large
  history, out-of-order live arrival, and stale cursor from another session;
- network: offline, DNS failure, TLS failure, 150 ms RTT, constrained bandwidth,
  1% packet loss, 401, 403, 404, 409, 429 with retry metadata, and every 5xx
  class returned by the surface;
- storage: unavailable object store, missing blob, expired signature, partial
  upload, corrupt manifest, corrupt tree index, and content hash mismatch.

## 7. Performance budgets

Budgets are measured from the user's action with a cold browser cache and again
with a warm cache. Reports include p50, p75, p95, p99, and worst observation.

| Metric | Release budget |
| --- | --- |
| Capture API response | p95 ≤ 200 ms when served from the deployment region |
| Capture-backed usable workbench | p95 ≤ 500 ms from navigation on the production network path |
| Warm-cache session switch | p95 ≤ 250 ms, with zero stale frames |
| Immediate interaction feedback | p95 ≤ 100 ms |
| Editor typing latency | p95 ≤ 50 ms per input event |
| Tree scroll and resize | p95 ≥ 55 frames/second; no sustained frame below 50 fps |
| Layout shift | CLS ≤ 0.05 for load, tab selection, capture→live reconciliation, and font settlement |
| Main-thread long tasks | No workbench task > 50 ms during ordinary interaction |
| Memory | No monotonic growth across 100 session switches, 100 file opens, or 20 terminal attach/detach cycles |
| Network | No duplicate identity-equivalent fetch and no request left alive after its identity is obsolete |
| Initial web asset graph | ≤ 750 KiB raw and ≤ 210 KiB gzip, including HTML, CSS, and recursive static imports |
| Direct session asset graph | ≤ 1,900 KiB raw and ≤ 540 KiB gzip before optional editor/diff/terminal chunks |
| Lazy JavaScript chunk | ≤ 800 KiB raw and ≤ 240 KiB gzip |
| CSS asset | ≤ 30 KiB gzip |
| Steer/Pause physical cancellation | worst ≤ 2,000 ms from committed control to replacement `turn.started` (Steer) or physically stopped activity (Pause), with zero zombie output |

Measure representative high-, mid-, and low-end desktop hardware plus current
iOS and Android devices. Include a 4× CPU slowdown and constrained-network run.
The bundle-size baseline is captured per release; an increase blocks unless the
same review includes measured user value, load impact, and an offsetting plan.

## 8. Accessibility and input acceptance

The release MUST satisfy WCAG 2.2 AA through automated and manual evidence:

- complete keyboard operation with logical order and always-visible focus;
- Escape/Enter/arrow/Home/End/PageUp/PageDown behavior appropriate to each
  composite widget;
- NVDA on Windows with Firefox and Chromium;
- VoiceOver on macOS Safari and iOS Safari;
- Android TalkBack with Chrome;
- semantic names, roles, states, relationships, live regions, and announcements;
- 200% text zoom and 400% reflow without lost content or two-dimensional page
  scrolling outside intentionally scrollable code/terminal regions;
- light, dark, forced/high-contrast, reduced-motion, and increased-contrast
  preferences;
- contrast ≥ 4.5:1 for ordinary text and ≥ 3:1 for large text and UI graphics;
- touch targets at least 44×44 CSS pixels with no precision-only gesture;
- no meaning conveyed by color, motion, hover, or pointer position alone;
- terminal, diff, and editor alternatives that expose status and controls to
  assistive technology even when their raw content is specialized.

Any serious or critical accessibility finding blocks release. Minor findings
also block while this contract requires zero known defects.

## 9. Visual and interaction quality

Visual acceptance is iterative, not a screenshot rubber stamp. During a major
surface introduction or redesign, perform enough independent desktop and mobile
passes to reach zero known defects and preserve before/after evidence for every
defect actually found. A clean candidate must not invent a defect merely to
satisfy a pass count. Ordinary releases retain the authenticated desktop/mobile
screenshots and fail on browser, accessibility, touch-target, or visual-state
errors detected by the live harness.

Review all combinations of:

- 320, 375, 390, 430, 768, 1024, 1280, 1440, 1920, and ultrawide viewports;
- light/dark/high-contrast and reduced-motion modes;
- loading, empty, populated, selected, hover, pressed, focus, disabled,
  read-only, saving, success, degraded, permission-denied, retryable-error, and
  fatal-error states;
- short/long labels, localized expansion, narrow/wide paths, and maximum badge
  counts;
- pointer, touch, keyboard, and screen-reader interaction.

Release-blocking visual defects include inconsistent spacing or radii,
misalignment, clipping, illegible density, unexplained whitespace, weak
hierarchy, ambiguous controls, missing feedback, jarring motion, scroll jumps,
focus loss, layout shift, mobile precision targets, and error states that look
like empty success.

Animations MUST be purposeful, interruptible, composited where possible, and
removed under reduced motion. Beauty cannot trade away speed, clarity, or
accessibility.

## 10. Browser and device matrix

As a change-triggered and scheduled readiness program, test the current and
previous stable releases of desktop Chromium, Firefox,
Safari, and Edge. Test current iOS Safari and Android Chrome on real devices;
emulation alone is insufficient. At minimum include:

- macOS desktop with mouse/trackpad and keyboard;
- Windows desktop with keyboard and NVDA;
- Linux Chromium/Firefox CI coverage;
- iPhone small and large form factors;
- representative mid-range Android phone;
- iPad/tablet portrait and landscape.

Unsupported behavior must be detected before interaction and communicated
truthfully. Browser-specific silent degradation is a defect.

## 11. Security and privacy

The readiness program must prove every item below. The per-candidate bundle
contains the subset exercised by the exact authenticated live harness, while
protected source tests retain the remaining isolation and residue proofs:

- workspace/session grants are checked before parsing sensitive request data;
- capture, file, diff, terminal, desktop, and event data cannot cross workspace,
  session, account, or authenticated-subject boundaries;
- signed URLs are short-lived, scoped, never logged, and refreshed safely;
- paths cannot escape the workspace root or reinterpret encoded traversal;
- terminal control, editor writes, and sandbox warming require the intended
  permissions and current identity;
- clipboard, downloaded content, browser storage, query caches, workers, and
  error artifacts contain no prior-user residue after sign-out;
- visual evidence uses only deterministic canary content;
- console logs, traces, analytics, and crash reports contain no file content,
  credentials, or signed URLs.

## 12. Staging, production, and soak

The release sequence is linear and fail-closed:

1. Merge reviewed source to `main`.
2. Merge the generated Version PR so the release source has exact package
   versions and no pending changesets.
3. Dispatch `release-candidate.yml` from that exact current `main` SHA and
   package plan. Build the five physical images once, record their digests, and
   record `migration → api`. The selected public OCI prefix must remain
   identical through candidate, embedded/final promotion, and BOM publication.
4. Deploy those exact receipt digests to staging.
5. Pass the complete authenticated live matrix on staging.
6. Run a failure-free staging soak long enough to cover sandbox expiry,
   hibernation, signed-URL expiry, and scheduled canary cycles.
7. Promote the identical digests to production; do not rebuild.
8. Re-run the production-safe acceptance subset immediately.
9. Run 72 hours of production canaries with zero failed, skipped, missing, or
   late cycles and no workbench SLO breach.
10. Publish packages only from the verified release commit, then retag the
    accepted manifests and emit the immutable package/image BOM without a
    Docker build.
11. Install the packages into a clean registry-only consumer and repeat the
    embedding smoke for CSR, SSR/hydration, optional-peer degradation, and
    production build output.

Rollback evidence is required before promotion. A rollback ends the candidate;
the release must restart from the changed source and new immutable artifacts.

## 13. Defect policy

- Every discovered defect gets a reproducible fixture and regression test.
- A reviewer finding is revalidated against the current artifact before action.
- No `skip`, `todo`, quarantine, expected failure, retry-to-green, visual
  tolerance expansion, or severity downgrade may make a required gate green.
- A flaky test is debugged as a race, isolation, or environment defect.
- A product fallback is accepted only when it is intentional, bounded,
  observable, accessible, and explicitly exercised; silent fallback is a bug.
- Completion requires a requirement-by-requirement evidence audit. A broad
  statement such as “CI passed” cannot close a specific live or visual row.

Cloudgeni-specific adoption and deployment credentials remain outside this
public contract. An embedding product may add stricter gates, but it may not
weaken these generic ones.
