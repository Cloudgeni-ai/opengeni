# @opengeni/runtime

## 0.18.17

### Patch Changes

- 55f6ad0: Use one terminal-response ordinal for provider context binding, and clear the
  durable input-token signal when the latest provider response supplies no usable
  usage instead of retaining an older response's count.
- 18eea76: Apply the configured Modal snapshot timeout to new sandboxes, rebind legacy resume envelopes to the current operational timeout without changing provider identity, and normalize durable SDK backend identifiers before product-provider lookup.

## 0.18.16

### Patch Changes

- 5b6d36e: Use provider-reported usage rather than whole-request approximations for automatic context compaction, preserve provider-only input-token state across context rewrites, and label timeline counts as estimated conversation-history tokens.
- Updated dependencies [5b6d36e]
- Updated dependencies [6eb0b23]
  - @opengeni/config@0.11.0
  - @opengeni/contracts@0.39.0

## 0.18.15

### Patch Changes

- Updated dependencies [8135dbb]
  - @opengeni/config@0.10.14

## 0.18.14

### Patch Changes

- c6c9acb: Recover required MCP setup when a transient socket failure is wrapped by the MCP SDK, while preserving only secret-safe transport classification.

## 0.18.13

### Patch Changes

- 69bc207: Keep Codex history canonical across subscriptions and providers, separate optional owner-designated Codex Apps authority from inference allocation, and fence Apps authorization through each remote request.
- c0f8e40: Prevent model-visible GitHub installation credential exposure and duplicate brokered MCP side effects after ambiguous 401 responses.
- Updated dependencies [69bc207]
- Updated dependencies [c0f8e40]
  - @opengeni/codex@0.2.11
  - @opengeni/contracts@0.38.3
  - @opengeni/config@0.10.13

## 0.18.12

### Patch Changes

- 8105c25: Honor explicit non-TTY sandbox commands without injecting terminal control bytes while preserving marker-bound process-group cancellation.

## 0.18.11

### Patch Changes

- 1ea5e62: Honor explicit shell and login selections when commands run on Connected Machines instead of substituting the machine service's ambient default shell.
- Updated dependencies [4502474]
  - @opengeni/contracts@0.38.2
  - @opengeni/config@0.10.12

## 0.18.10

### Patch Changes

- Updated dependencies [664c1d8]
  - @opengeni/network@0.2.0

## 0.18.9

### Patch Changes

- Updated dependencies [c9d8b69]
  - @opengeni/contracts@0.38.1
  - @opengeni/config@0.10.11

## 0.18.8

### Patch Changes

- Updated dependencies [b6e39fc]
- Updated dependencies [bef5920]
  - @opengeni/config@0.10.10
  - @opengeni/contracts@0.38.0

## 0.18.7

### Patch Changes

- Updated dependencies [4976e1c]
  - @opengeni/network@0.1.2

## 0.18.6

### Patch Changes

- Updated dependencies [fd13ba9]
  - @opengeni/contracts@0.37.0
  - @opengeni/config@0.10.9

## 0.18.5

### Patch Changes

- Updated dependencies [abe0de6]
  - @opengeni/config@0.10.8
  - @opengeni/contracts@0.36.1

## 0.18.4

### Patch Changes

- Updated dependencies [00f7d3b]
  - @opengeni/contracts@0.36.0
  - @opengeni/config@0.10.7

## 0.18.3

### Patch Changes

- Updated dependencies [b121e7c]
  - @opengeni/contracts@0.35.0
  - @opengeni/config@0.10.6

## 0.18.2

### Patch Changes

- Updated dependencies [b83af7a]
  - @opengeni/contracts@0.34.0
  - @opengeni/config@0.10.5

## 0.18.1

### Patch Changes

- 74bd3a5: Project image content and image-only tools from the model capability catalogue without mutating durable session history.
- Updated dependencies [d1f0c3d]
- Updated dependencies [1d0f2ae]
- Updated dependencies [74bd3a5]
- Updated dependencies [3e4842d]
  - @opengeni/contracts@0.33.0
  - @opengeni/config@0.10.4

## 0.18.0

### Minor Changes

- e03397d: Freeze workspace instruction policies and structured preference descriptors at
  the accepted logical-turn boundary, add immutable per-session policy roles, and
  compose the resulting exact-attempt governance into agent and compaction prompts.

### Patch Changes

- Updated dependencies [13b961e]
- Updated dependencies [ecc4288]
- Updated dependencies [e03397d]
- Updated dependencies [4f15920]
- Updated dependencies [3baaebd]
  - @opengeni/contracts@0.32.0
  - @opengeni/codex@0.2.10
  - @opengeni/config@0.10.3

## 0.17.2

### Patch Changes

- b4982fa: Pin DeepSeek V4 Flash and Kimi K3 to ordered, approved Vercel AI Gateway
  provider routes, meter managed usage from Gateway-reported cost, and preserve
  Kimi Responses tool continuity without exposing provider details in the UI.
- 70e6d56: Preserve the intentional connected-machine manifest no-op while retaining
  in-provider materialization visibility checks for managed sandboxes.
- Updated dependencies [e62495f]
- Updated dependencies [b4982fa]
- Updated dependencies [b4982fa]
  - @opengeni/contracts@0.31.2
  - @opengeni/config@0.10.2

## 0.17.1

### Patch Changes

- 9c4d73d: Add curated OpenGeni-credit and workspace-key Vercel AI Gateway model paths for
  DeepSeek V4 Flash and Kimi K3, including exact provider routing, cache-aware
  pricing and metering, Responses tool continuity, provider-blind catalog UX, and
  stable remote-compaction cache prefixes.
- Updated dependencies [9c4d73d]
  - @opengeni/config@0.10.1
  - @opengeni/contracts@0.31.1

## 0.17.0

### Minor Changes

- 8b3e46f: Allow a digest-pinned capability-pack sandbox image to bind an immutable Modal image ID. OpenGeni now preserves the logical OCI digest on the lease, starts the provider-native image through `ModalImageSelector.fromId`, records the actual ID in the Modal session envelope, clears lower-precedence IDs when a rig overrides the image, and keeps catalog image metadata aligned with the runtime manifest.

### Patch Changes

- Updated dependencies [8b3e46f]
  - @opengeni/config@0.10.0
  - @opengeni/contracts@0.31.0

## 0.16.3

### Patch Changes

- e07eb52: Enforce frozen Allow, Ask, and Block connector action policies before provider execution while persisting metadata-only approval, decision, and outcome evidence.

## 0.16.2

### Patch Changes

- Updated dependencies [2321119]
  - @opengeni/contracts@0.30.0
  - @opengeni/config@0.9.3

## 0.16.1

### Patch Changes

- f4fa05c: Preserve structured exec results when routing to execCommand-only sandbox backends so file, Git, and PTY operations retain provider output and process authority.
- dd71248: Make workspace-owned MCP OAuth connections the default, add explicit personal
  connection ownership, and preserve exact delegated personal authority across
  turns, child sessions, goals, schedules, retries, and recovery with safe
  tool-level degradation when a personal connection is unavailable.
- Updated dependencies [dd71248]
  - @opengeni/contracts@0.29.0
  - @opengeni/config@0.9.2

## 0.16.0

### Minor Changes

- 38ba6bc: Add bounded routed-sandbox provider operation observations and the fail-safe
  Prometheus observer used by API-direct and worker turn execution.

## 0.15.3

### Patch Changes

- Updated dependencies [659b3ff]
  - @opengeni/contracts@0.28.1
  - @opengeni/config@0.9.1

## 0.15.2

### Patch Changes

- 3b8d653: Allow Modal-backed repository sessions to enumerate workspace skill directories so optional discovery does not fail before a turn and repository skills remain available after resume. Keep the shared filesystem confinement path functional on stock macOS as well as GNU/Linux.
- Updated dependencies [d4d8960]
- Updated dependencies [ec0bc02]
- Updated dependencies [5a4c559]
  - @opengeni/contracts@0.28.0
  - @opengeni/config@0.9.0

## 0.15.1

### Patch Changes

- Updated dependencies [8243ffe]
  - @opengeni/config@0.8.1

## 0.15.0

### Minor Changes

- 1ec9912: Add generic, versioned workspace artifacts with content-addressed HTML storage, a static HTML/CSS renderer, rollback history, and first-party agent publishing tools. JavaScript and active or navigation-capable markup are removed from the initial renderer until executable artifacts have a stronger isolation boundary.

### Patch Changes

- Updated dependencies [dcc35c5]
- Updated dependencies [1ec9912]
  - @opengeni/config@0.8.0
  - @opengeni/contracts@0.27.0

## 0.14.16

### Patch Changes

- cb4d78d: Preserve exact-source CI dogfood image aliases when promoting versioned release candidates.

## 0.14.15

### Patch Changes

- c52acc0: Ship Fast latency mode with turn-column inheritance, Codex ChatGPT honor-skip for response service_tier, and model picker UX polish.
- Updated dependencies [c52acc0]
  - @opengeni/codex@0.2.9
  - @opengeni/config@0.7.22
  - @opengeni/contracts@0.26.1

## 0.14.14

### Patch Changes

- 11cdf20: Allow hosted Linux sandbox cancellation to validate process identity through `/proc` when a minimal image omits `ps`.

## 0.14.13

### Patch Changes

- Updated dependencies [f413e6c]
  - @opengeni/contracts@0.26.0
  - @opengeni/config@0.7.21

## 0.14.12

### Patch Changes

- 42428a2: Add per-session Codex remote compaction v2 (`remote_v2` / `portable`), with UI landmarks, Codex-only model locking, and opaque token accounting aligned to Codex CLI.
- b2e975f: Advance the merged knowledge release train to fresh publication identities without changing runtime behavior. This corrective source is derived from current main and does not reuse generated release output.
- Updated dependencies [0199108]
- Updated dependencies [42428a2]
- Updated dependencies [b2e975f]
- Updated dependencies [9f3b931]
  - @opengeni/contracts@0.25.0
  - @opengeni/config@0.7.20

## 0.14.11

### Patch Changes

- b7df541: Prevent provider-native checkpoint capture from racing sandbox operations while
  the provider has paused the source box. Capture now owns a durable
  lease/epoch/instance/generation claim, blocks new holders and mutations, drains
  provider-local reads before entering the exclusive snapshot call, and retains
  ownership through late provider settlement and exact stale-claim recovery.
  Modal's typed completed-exec stdin race is also normalized into a side-effect-free
  terminal poll, so an exec that exits between local lookup and the provider write
  settles its retained process instead of failing the enclosing turn.
- Updated dependencies [710b081]
- Updated dependencies [b7df541]
  - @opengeni/contracts@0.24.3
  - @opengeni/config@0.7.19

## 0.14.10

### Patch Changes

- 96eb64b: Advance the reviewed knowledge release package graph to fresh publishable identities after the previous version projection was invalidated. This changes release metadata only and does not alter runtime behavior.
- Updated dependencies [96eb64b]
  - @opengeni/config@0.7.18
  - @opengeni/contracts@0.24.2

## 0.14.9

### Patch Changes

- 3450ee5: Estimate typed images as bounded native media only after validating PNG IHDR CRCs, preserve exact model-history prefixes across requests, and fail closed for computer use whenever hosted or structured-image transport is omitted or unproven so screenshots cannot become base64 function text.
- Updated dependencies [ddff8db]
- Updated dependencies [0a9a6eb]
  - @opengeni/contracts@0.24.1
  - @opengeni/config@0.7.17

## 0.14.8

### Patch Changes

- Updated dependencies [6d167f4]
  - @opengeni/codex@0.2.8
  - @opengeni/config@0.7.16

## 0.14.7

### Patch Changes

- a19971e: Treat native provider snapshot receipts as typed opaque artifacts instead of tar
  trees; track every Modal Image in a provider-bound, crash-safe checkpoint ledger;
  garbage-collect displaced and publication-losing Images; adopt only provable
  legacy ownership; bind retained processes to their exact Modal namespace and
  reconcile historical terminal boxes without touching successors; rotate finite
  Modal boxes through the canonical checkpoint/drain/rematerialization path before
  their persisted deadline without checkpointing across an active direct API
  mutation; memoize terminal recovery failures; and use Modal's
  documented 24-hour maximum as the default hard box lifetime. Frame confined
  filesystem/Git command output at both boundaries with a fresh attempt nonce and
  strict exit-status parsing so provider diagnostics, truncation, or delayed
  retries cannot corrupt Modal-like `execCommand` control records. Upgrade the
  Modal JavaScript SDK to 0.9.0 and explicitly retain native checkpoint Images
  until the provider-bound artifact ledger proves that their exact ids are safe
  to garbage-collect.
- Updated dependencies [a19971e]
- Updated dependencies [1f6f13f]
  - @opengeni/config@0.7.15
  - @opengeni/contracts@0.24.0

## 0.14.6

### Patch Changes

- 2a7900f: Make Channel-A Git capture hashing and descriptor confinement portable across Linux and stock macOS/BSD while preserving bounded, fail-closed repository-diff integrity.
- 821f664: Seed shared session-event cursors from loaded history to prevent historical replay storms, and preserve the MCP SDK's exact request-timeout classification through safe transport-error sanitization.

## 0.14.5

### Patch Changes

- Updated dependencies [ad0bdc3]
  - @opengeni/contracts@0.23.1
  - @opengeni/config@0.7.14

## 0.14.4

### Patch Changes

- 39b1b84: Keep MCP request timeouts distinct from recoverable connection authentication errors.
- bcb50cf: Thread the configured Connected Machine control and exec deadlines through
  `run_on`, and return truthful typed timeout/deadline command receipts without
  replaying ambiguous execution.

## 0.14.3

### Patch Changes

- 36451c6: Support an explicit shared workspace base directory for containerized Docker workers.
- Updated dependencies [33dc88f]
- Updated dependencies [36451c6]
  - @opengeni/contracts@0.23.0
  - @opengeni/config@0.7.13

## 0.14.2

### Patch Changes

- Updated dependencies [1c4018e]
  - @opengeni/config@0.7.12
  - @opengeni/contracts@0.22.1

## 0.14.1

### Patch Changes

- 29ad09b: Persist typed machine inputs into canonical model history at turn claim, expose
  authoritative pending-input queue projections and lifecycle events, render
  delivered batches in the timeline, and preserve append-only prompt-cache
  prefixes across tools, later turns, recovery, and explicit compaction.
- b2e23f3: Resolve Connected Machine Toolspace token files against the machine user's real
  home directory instead of the selfhosted capability root.
- dfc3235: Separate first-party MCP authorization from exact per-session tool visibility, add fail-closed registration policy, and isolate file download URLs on the files MCP surface.
- Updated dependencies [29ad09b]
- Updated dependencies [b2e23f3]
- Updated dependencies [dfc3235]
  - @opengeni/contracts@0.22.0
  - @opengeni/config@0.7.11

## 0.14.0

### Minor Changes

- 519d93c: Add validated inline per-session skills and discover skills directly from already-materialized repository resources.

### Patch Changes

- Updated dependencies [519d93c]
  - @opengeni/contracts@0.21.0
  - @opengeni/config@0.7.10

## 0.13.14

### Patch Changes

- 110bb77: Enforce exact-subject ownership for personal OAuth capabilities and add secure direct OAuth installation for the separate workspace OpenGeni Slack bot.
- Updated dependencies [110bb77]
  - @opengeni/config@0.7.9
  - @opengeni/contracts@0.20.2

## 0.13.13

### Patch Changes

- f92af07: Remove Bun-global dependencies from the worker turn path and Docker network attachment so embedded workers run identically in Node and Bun.

## 0.13.12

### Patch Changes

- ffd246c: Keep workspace-capture Git status, diffs, and untracked files below provider retained-output limits, and publish an explicit degraded revision instead of an authoritative empty diff when repository reads fail.
- Updated dependencies [ffd246c]
  - @opengeni/contracts@0.20.1
  - @opengeni/config@0.7.8

## 0.13.11

### Patch Changes

- Updated dependencies [06a5801]
- Updated dependencies [9326255]
- Updated dependencies [5511c24]
  - @opengeni/contracts@0.20.0
  - @opengeni/config@0.7.7

## 0.13.10

### Patch Changes

- 543bb26: Expose a secret-free Git credential binding inventory to managed-sandbox agents so multi-account provider CLI routing is discoverable outside an attached repository.
- 8356146: Scope progressive MCP tool search and context accounting to the authoritative configured server identities while keeping the mandatory OpenGeni tools eager.
- Updated dependencies [9a8f793]
- Updated dependencies [c135339]
  - @opengeni/contracts@0.19.4
  - @opengeni/config@0.7.6

## 0.13.9

### Patch Changes

- Updated dependencies [a0f2442]
  - @opengeni/contracts@0.19.3
  - @opengeni/config@0.7.5

## 0.13.8

### Patch Changes

- Updated dependencies [85cb323]
  - @opengeni/config@0.7.4
  - @opengeni/contracts@0.19.2

## 0.13.7

### Patch Changes

- 1386679: Make context compaction provider-portable with Codex-compatible plaintext checkpoints, drop
  foreign account-bound reasoning during subscription rotation, and preserve the exact logical turn
  through durable all-subscriptions-exhausted capacity waits.
- de20184: Redact known runtime credentials and recognized authorization, cookie, signed
  URL, assignment, and provider-token shapes before model calls, durable session
  history, events, logs, and telemetry. Disable credential-bearing shell xtrace
  and raw Agents SDK model, tool, and MCP transport payload logging.
- Updated dependencies [5685f32]
- Updated dependencies [de20184]
  - @opengeni/config@0.7.3
  - @opengeni/contracts@0.19.1

## 0.13.6

### Patch Changes

- Updated dependencies [7c6aa7c]
  - @opengeni/config@0.7.2

## 0.13.5

### Patch Changes

- d03ee4b: Correct the Terraform Stack troubleshooting example to use a portable placeholder for an absolute module path.

## 0.13.4

### Patch Changes

- ac20b93: Use Bun's native fetch transport for MCP requests so external servers do not hang in the Undici compatibility path.
- Updated dependencies [55c6559]
  - @opengeni/config@0.7.1

## 0.13.3

### Patch Changes

- 43e3503: Honor configured MCP transport budgets during the outer Agents SDK connection lifecycle.

## 0.13.2

### Patch Changes

- 5b57a2d: Make provisioned-sandbox recovery truthful and atomic. Provider existence,
  lease liveness, route attachment, archive availability, restore progress,
  verified workspace readiness, and epochs are exposed separately; attach/swap
  must certify readiness. Definitive provider loss is exact-instance fenced,
  concurrent observers receive typed recovery/superseded outcomes, and ambiguous
  operations are never replayed. Rematerialization selects one verified archive
  revision under the lease lock, verifies archive bytes and restored tree contents,
  and fails closed as degraded or unrecoverable instead of publishing a partial,
  mixed, previous, or clean fallback workspace.

  Unify every persistable workspace mutation under durable turn, API-direct, or
  retained-process authority. Direct requests use exact request UUID holders;
  yielded processes retain their parent admission and exact pinned provider/route
  identity until durable exit/loss settlement. Direct/process authority blocks
  archive capture, process stdin receives a distinct mutation admission, and PTY
  control cannot be rerouted by active-pointer movement.

  Make terminal execution physically synchronous: `terminalExec` always returns a
  numeric `exitCode` with `running: false`, and timeout/error paths return only
  after exact process-group absence and retained settlement. Interactive PTYs open
  only after durable promotion, close only on exact terminal proof, and report
  provider loss truthfully.

  Activate the generation/process schema through maintenance migration 0117. All
  old API/control/turn writers must stop before the one-way cutover and may not
  restart afterward; archive completeness requires the exact closed generation.

- Updated dependencies [c549ed8]
- Updated dependencies [46bac05]
- Updated dependencies [860de22]
- Updated dependencies [5b57a2d]
  - @opengeni/contracts@0.19.0
  - @opengeni/config@0.7.0

## 0.13.1

### Patch Changes

- Updated dependencies [744a93d]
  - @opengeni/config@0.6.10
  - @opengeni/contracts@0.18.1

## 0.13.0

### Minor Changes

- 0d60720: Add capability-first session tool policies with omission-as-discovery defaults,
  explicit per-turn narrowing and child inheritance, secret-safe effective-policy
  projections, stable lazy `tool_search` catalogs, and matching API, SDK, React,
  worker, embedding, and audit contracts.

  Harden credential-bearing MCP and OAuth traffic with destination-bound
  credentials, single-resolution DNS-pinned transport, bounded catalogs, schemas,
  results, request and response bodies, and independently validated manual
  redirects. Extend renewable, session-bound Toolspace access to connected
  machines while dynamically fencing every call to the session's active attempt.

### Patch Changes

- bdd531c: Make Codex subscription response timeouts recoverable without blindly replaying partially observed model work. The transport now assigns a durable request identity, records attempt-fenced start/headers/first-byte/terminal metadata, enforces explicit headers, stream-idle, and whole-request deadlines, and retries once only before any response is observed. Exhausted or partial-stream timeouts retain a typed failure class and return the durable session to its existing retryable recovery path instead of hard-failing it with the opaque OpenAI SDK `Request timed out.` error. External cancellation remains authoritative, the SDK retry budget remains disabled, and Codex subscription turns keep their existing zero-credit billing path.
- Updated dependencies [0d60720]
- Updated dependencies [bdd531c]
  - @opengeni/config@0.6.9
  - @opengeni/contracts@0.18.0
  - @opengeni/network@0.1.1
  - @opengeni/codex@0.2.7

## 0.12.6

### Patch Changes

- 524599e: Normalize model, provider, upstream deployment, credential source, billing,
  capability, health, and pricing identity; expose a secret-safe authenticated
  workspace catalog with separate fail-closed credential readiness for federated
  providers; and persist the accepted model/reasoning execution policy on new
  logical turns.
- Updated dependencies [524599e]
  - @opengeni/config@0.6.8
  - @opengeni/contracts@0.17.3

## 0.12.5

### Patch Changes

- Updated dependencies [229902b]
  - @opengeni/codex@0.2.6
  - @opengeni/config@0.6.7

## 0.12.4

### Patch Changes

- cb188f9: Protect clean rig verification sandboxes with canonical exact-instance leases, make Modal orphan termination revalidate durable ownership immediately before deletion, and add a default-off two-phase rollout flag.
- Updated dependencies [4966649]
- Updated dependencies [cb188f9]
  - @opengeni/contracts@0.17.2
  - @opengeni/config@0.6.6

## 0.12.3

### Patch Changes

- 2174006: Bound Modal display startup ownership, parse terminal state only from trusted provider metadata, poll yielded processes to completion, and prevent detached desktop processes from retaining startup locks.
- 4e16410: Preserve provider-reported prompt-cache writes through source-key-authoritative production usage paths, deduplicate mirrored and retried terminal responses before response-scoped side effects, derive billing and context totals from canonical input/output and complete SDK request aggregates, distinguish unknown cache reads from real zeros with call-traffic-aware availability alerting, and reject inconsistent or unsafe token values before billing or metrics.

## 0.12.2

### Patch Changes

- Updated dependencies [ff23da5]
  - @opengeni/contracts@0.17.1
  - @opengeni/config@0.6.5

## 0.12.1

### Patch Changes

- Updated dependencies [d1dee7a]
  - @opengeni/contracts@0.17.0
  - @opengeni/config@0.6.4

## 0.12.0

### Minor Changes

- b9cec61: Let embedding hosts return exact HTTPS smart-Git broker transports for repository
  bindings whose provider credentials cannot be contained to the selected
  repositories. Keep broker bearers off manifests, Git configuration, repository
  metadata, and provider CLIs; renew bearers independently without changing the
  admitted route set.

### Patch Changes

- Updated dependencies [b9cec61]
- Updated dependencies [c978676]
  - @opengeni/contracts@0.16.0
  - @opengeni/config@0.6.3

## 0.11.0

### Minor Changes

- 9f84cc9: Add durable host-provided per-turn instructions, headless structured-input hooks, host-local queue
  focus, and reusable approval and human-input surfaces for embedded session consumers.

### Patch Changes

- Updated dependencies [9f84cc9]
  - @opengeni/contracts@0.15.0
  - @opengeni/config@0.6.2

## 0.10.0

### Minor Changes

- 136227e: Add an immutable, versioned curated skill library with explicit workspace selection and inspectable provenance, and preserve WCAG AA contrast for dark-theme primary actions.

### Patch Changes

- Updated dependencies [136227e]
- Updated dependencies [3aee519]
  - @opengeni/contracts@0.14.0
  - @opengeni/config@0.6.1

## 0.9.0

### Minor Changes

- 1fcd83d: Make repository mount paths provider-neutral and collision-free. Omitted paths
  now resolve to a canonical host-aware default that distinguishes GitHub,
  GitLab, Azure DevOps, and custom hosts, while one shared portable-path validator
  rejects traversal and case-folded collisions before sandbox execution.

  Hosts upgrading sessions persisted without `mountPath` should expect those
  repositories to materialize at the new host-aware location. To preserve an
  existing warm workspace location, stamp the session's former effective
  `repos/<owner>/<repo>` path explicitly before upgrading. Previously accepted
  explicit paths that are non-portable or collide after Unicode normalization and
  case folding now fail validation and must be renamed.

- 4401ce7: Add a scope-checked host MCP credential resolver to the public embedding port and use it consistently for model-visible MCP tools and Toolspace/Code Mode while preserving the standalone connection broker as the default. Requests carry both the immediate session and its workspace-scoped lineage root so embedded hosts can authorize child sessions through one durable root binding. Provider-neutral bindings now carry a provider family, provider host, opaque host binding id, and exact selected-repository set; successful credentials must echo the complete binding before headers are accepted. Incompatible endpoint authentication and unenforceable resource containment surface as explicit unavailable states instead of starting a duplicate OpenGeni provider connection.
- c389adc: Add a provider-neutral host run-credential port with frozen turn/session lineage,
  off-manifest environment and file generations, proactive renewal, attempt-safe
  cleanup with bounded generation retention, output redaction hints, and structured
  reconnect UI support. Hosts can explicitly opt a frozen target out, and the
  POSIX materializer supports both Linux `flock` and a portable directory-lock
  fallback with cross-platform base64 decoding.
- 3ce795b: Route Toolspace token seeding, renewal, agent commands, and Channel-A terminal
  commands through deterministic per-session files when several sessions share a
  sandbox group. Preserve the box manifest's stable legacy pointer for warm-box
  compatibility, remove any legacy bearer during seeding, and prevent the
  group-global ttyd process from inheriting session-bound Toolspace authority.
- 334b63f: Publish the dependency-free Toolspace CLI, consume its canonical source from stock sandbox images, and expose an exact deployment-pinned bootstrap hint so custom rigs and connected machines can install it without ever guessing `latest`.
- a11a7fc: Support mixed GitHub, GitLab, and Azure DevOps repositories—including multiple
  accounts or installations for one provider—in a single session through bounded,
  host-opaque credential bindings and optional read/write access intent.

  Validate binding/provider/host echoes before token injection, isolate tokens in
  hashed binding files, select Git credentials by remote path, fail provider CLIs
  closed on ambiguous bindings, and renew each binding independently while keeping
  legacy one-binding-per-provider request and file aliases compatible.

- dda6398: Add durable structured human-input tool calls with exact-turn ownership,
  answer/skip/expiry/cancellation outcomes, restart-safe Temporal resumption,
  authorized API and SDK methods, and headless plus styled React embed surfaces.

### Patch Changes

- 94f2580: Keep sandbox Toolspace and Code Mode available during unbounded turns by
  proactively re-signing the session-bound delegated bearer and atomically
  replacing its off-manifest token file on managed and connected-machine backends.
- b9d6e58: Bundle the OpenAI Agents implementation together with its required Zod 4 runtime so embedding hosts can retain an independent Zod major without silently changing Agents' schema identity, while keeping transitive runtime dependencies explicit and Node-compatible.
- Updated dependencies [1fcd83d]
- Updated dependencies [32011f1]
- Updated dependencies [3983021]
- Updated dependencies [4401ce7]
- Updated dependencies [c389adc]
- Updated dependencies [1f9305b]
- Updated dependencies [8c66185]
- Updated dependencies [334b63f]
- Updated dependencies [d249403]
- Updated dependencies [a11a7fc]
- Updated dependencies [44ff327]
- Updated dependencies [dda6398]
- Updated dependencies [5529945]
- Updated dependencies [e8ca4f6]
- Updated dependencies [736f4fe]
  - @opengeni/contracts@0.13.0
  - @opengeni/config@0.6.0

## 0.8.2

### Patch Changes

- Bound model-facing tool output, complete input accounting, compact session discovery,
  event and realtime projections, authorized evidence retrieval, and compaction failure
  convergence with explicit truncation and loss metadata throughout the output lifecycle.
  Session event `latest` lookups are now class-exclusive across REST, MCP, and SDK clients.
  Updated-order session discovery now uses a transactional workspace activity-revision fence,
  and the workspace-control bounds migration rewrites only historical cap violations.
- Updated dependencies
- Updated dependencies [dbb6232]
- Updated dependencies [3e65c23]
  - @opengeni/codex@0.2.5
  - @opengeni/config@0.5.3
  - @opengeni/contracts@0.12.0

## 0.8.1

### Patch Changes

- 28290a0: Make context compaction and pending tool-call recovery converge without reactivating superseded history or repeating failed internal turns.
- 9a7dec2: Keep captured workspace files and diffs usable when the live sandbox provider is temporarily unavailable, surface a truthful retryable degraded state, and distinguish provider failures from invalid workspace paths.

## 0.8.0

### Minor Changes

- ec0697a: Ship the production-hardened captured workspace workbench, physically verified Steer/Pause cancellation across cloud, local, and self-hosted model tools, pre-model preparation, sandbox provisioning, and lifecycle/setup commands, durable quiescence admission fencing, cancellation-aware SDK reads and turn cleanup, single-round-trip pruned workspace indexing, truthful shutdown states, a responsive and accessible review dock, Unicode coverage, and package-safe CSS/SSR integration.

### Patch Changes

- 14ce2e3: Bound model-facing textual tool output with Codex-compatible, replay-idempotent semantics, account
  for complete current model input, make compaction failure/progress transitions
  durable and convergent, and replace recursive session discovery with a compact
  paginated projection.
- Updated dependencies [14ce2e3]
- Updated dependencies [ec0697a]
  - @opengeni/codex@0.2.4
  - @opengeni/config@0.5.2
  - @opengeni/contracts@0.11.0

## 0.7.1

### Patch Changes

- Updated dependencies [6882ff2]
  - @opengeni/codex@0.2.3
  - @opengeni/config@0.5.1

## 0.7.0

### Minor Changes

- a0cb58f: Streaming exec to Connected Machines over the op-stream protocol (server half).
  When a runner advertises the `op_stream` capability (persisted from its connect
  Hello onto the enrollment) and `OPENGENI_AGENT_OP_STREAM_ENABLED` is on
  (default off), selfhosted exec streams as sequenced, acked, credit-flowed
  frames: no reply-size wall (retention-bounded, typed on overflow), blip-proof
  collection (re-attach + replay, blake3-verified byte-exact), and idempotent
  starts keyed by a durable per-tool-call op id so a re-dispatched turn attaches
  to the already-running command instead of re-running it. The legacy monolithic
  exec remains the permanent fallback wire form. The events bus gains an
  op-stream subscribe/publish accessor on the same managed NATS connection.

### Patch Changes

- ad4502a: Make the workbench and console dependency-safe, keep list identities stable, preserve caught error causes, isolate desktop consent tests from real transports, and enforce warning-free repository lint plus aggregate React tests in CI.
- ec508d4: Proactive context compaction now actually fires on the codex-subscription path: codex models declare their real (empirically measured) context window instead of inheriting the 1.05M global default, and the default compaction trigger moves from 60% to 90% of the declared window — compact as late as possible now that the window base is honest, with the reactive compact-on-reject ladder absorbing any overshoot.
- 477b2bb: Freeze the codex tool_search description for the whole turn once connectors are discovered, instead of re-rendering it from the live connector-namespace Set on every model call. A mid-turn Set change used to flip the tools block, which precedes the conversation history in the request prefix and so cold-started the entire prompt-cache prefix from that point on. The freeze locks the first discovered (non-empty) connector list and reuses it byte-stably for the rest of the turn; while the Set is still empty (discovery slow/failed) it falls back to a live render rather than freezing an empty list, so a turn's connectors are never silently disabled.
- 04d7595: Discover repositories at any workspace nesting depth, including linked worktrees whose `.git` marker is a file, while pruning dependency/build residue and enforcing timeout and repository-count bounds. An incomplete discovery now persists an epoch-fenced degraded capture revision, announces its typed reason, and makes clients prefer live workspace data instead of presenting a misleading empty capture.
- 0805620: Make active-sandbox pointer swaps establishment-safe. A swap or create-time seed to a target no turn can establish (a non-group Modal sibling, or an unknown backend kind) is now rejected before the epoch-fenced pointer commit with a typed rejection `code`, leaving the pointer and epoch untouched. At turn start a persisted pointer whose target is structurally unestablishable (a deleted sandbox row, a Modal sibling, or an enrollment-less selfhosted row) is reset to the session home under the epoch fence and announced with a new `session.route.reconciled` event, honoring a concurrent higher-epoch swap rather than clobbering it. A null pointer resolves to the session home backend, and the routing proxy's per-op cache is keyed on the full `(activeEpoch, activeSandboxId)` tuple so a clear-to-null re-lands the next op on home rather than a stale swapped-to session. Adds the optional `SwapActiveSandboxResponse.code` discriminant and the `session.route.reconciled` session event type to the public contracts and SDK wire types.
- 1132866: Surface the Connected Machine (selfhosted) exec-deadline hint on the stdout-only SDK path: when a command is killed at its exec deadline, `execCommand` now returns the "terminated at the N-second limit — run long jobs in the background and poll" hint as its output (alone when stdout is empty, appended after the partial output otherwise), instead of returning an empty string the model reads as "no output". The structured `exec()` result is unchanged (the hint stays on stderr for the Channel-A parsers); it now also carries a `timedOut` flag.
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

- 832f84c: Re-sign the first-party MCP delegated bearer per request so a long turn never 401s on an expired token. The first-party (`opengeni`) MCP server's delegated bearer is signed with a 1-hour TTL and was baked into the StreamableHTTP connection headers once, at turn start. A turn or persistent MCP connection that outlived the TTL re-sent the stale bearer on its next request (a tool call or the SDK's per-step tools/list re-list), the endpoint rejected it with a 401 "authentication required", and — because the first-party server is required — the whole turn died (observed as a session that "ran fine for about an hour, then failed"). The bearer is now re-signed on every request by a dedicated first-party auth fetch wrapper (the same per-request `fetch` mechanism the connection broker already uses), so the token on the wire is always fresh and the endpoint never 401s, for a turn of any length. The change is scoped strictly to the delegated token we mint ourselves; external OAuth credentials (connection-broker-backed capability MCPs) are untouched and still degrade or fail-loud with human re-auth. A genuinely broken first-party auth still fails loud — the wrapper always sends a valid fresh token and never retries, so a persistent rejection surfaces as a hard connect failure rather than being masked.
- b125213: Proactively renew GitHub, GitLab, and Azure DevOps credentials during multi-day managed-sandbox turns, atomically replacing stable token files without model action or manifest mutation.
- b804fd4: Add provider-neutral git credential contracts and runtime sandbox token-file seeding for GitHub, GitLab, and Azure DevOps. Sandboxes now provision `gh`, `glab`, and `az` wrappers that read current token files at invocation time without storing token values in manifests.
- 37ade2c: Never serialize the internal resume-message marker (`opengeni_internal_resume` in item providerData) to any model provider. The @openai/agents SDK spreads providerData keys verbatim into the wire item and strict Responses backends reject unknown per-item fields — in production every turn whose input contained a marked resume message failed deterministically with `400 Unknown parameter: 'input[N].opengeni_internal_resume'`, and because the marker is durable in replayed conversation history, retries could never succeed (sessions stayed dead). The sanitizer now strips the key from every history item and from the fresh trailing resume message before ANY model request; unrelated providerData keys are preserved and untouched items keep reference identity. Resume-notice detection (isInternalResumeMessage) reads stored history and keeps its text-prefix fallback, so compaction housekeeping degrades gracefully instead of ever failing a turn.
- 4a25bfc: Connected Machines read OFFLINE immediately on a clean going-offline. When a machine announces a typed GoingOffline (user-stop / self-update / host-shutdown) it now records a nullable `went_offline_at` + `went_offline_reason` marker on its enrollment, and the liveness derivation gives an un-cleared marker precedence over last_seen aging AND over a lingering liveness probe — so the dashboard and any work-routing decision see the machine as offline right away instead of waiting out the dead-detect window. A lifecycle `revoked` status still trumps the marker, and any newer liveness signal (a reconnect Hello or a fresher heartbeat) clears it back to null. Adds the `setEnrollmentWentOffline` and `clearEnrollmentWentOffline` DB helpers, threads the marker onto `EnrollmentRecord` and the `selfhostedLiveness` input, and clears it inside `touchEnrollmentLastSeen`.
- 63f9113: Isolate optional/best-effort MCP servers so an expired credential can never fail an unrelated turn. A best-effort server (an optional ToolRef, a connection-broker-backed capability MCP, or codex_apps) whose `tools/list` throws at run time — most often an expired/failed connection credential surfacing as a StreamableHTTP "authentication required" 401 — now degrades to zero tools for the turn instead of propagating out of the SDK's run-time `getAllMcpTools` and hard-failing the whole turn. Previously the best-effort isolation only wrapped the connect handshake, so a server that connected fine but had its credential expire by tool-listing time took down turns that never even used its tools. Required (explicitly-requested, non-best-effort) servers keep the fail-loud default: a `tools/list` failure still fails the turn. The actionable `tool.auth_needed` signal is preserved — the connection-broker fetch publishes it before returning the 401 that provokes the throw, so the drop is fully observable and the user still gets prompted to re-authenticate.
- f4a25d9: Isolate best-effort MCP tool INVOCATION failures so an optional server can never fail an unrelated turn — the invocation sibling of #379's tools/list fix. When the model calls a best-effort server's tool (an optional ToolRef, a connection-broker-backed capability MCP, or codex_apps) and the call throws for any reason — a raw transport 401/403 that never became the broker's JSON-RPC auth-needed short-circuit (e.g. a bearer that expired mid-turn), a provider 5xx, or a network blip — `PrefixedMcpServer.callTool` now returns a tool-error result the model sees instead of propagating the throw. A required server keeps the fail-loud default. The model-facing copy is loop-safe (it says the tool is unavailable for the rest of the turn and to not retry it, so the model moves on instead of re-calling a dead tool), and both the model text and the structured warn carry only the safe error surface (JS error class + numeric HTTP status), never the raw response body — a broker 401/403 body can echo request detail. The existing auth-needed short-circuit and its `tool.auth_needed` signal are unchanged and take precedence. The same errorClass/status-only surface is applied to the #379 tools/list warn for consistency. The mid-turn tools/list RE-LIST path was already covered by #379 (the guard is on the `PrefixedMcpServer.listTools` instance method, which every re-list goes through); a regression test locks it.
- 726cf2c: Make Connected Machine (selfhosted) control ops resilient: bounded retry of pre-admission DRAINING backpressure (patient ~60s budget for exec, short ~5s for other ops) and of a single transient TIMEOUT (read-only idempotent ops only — a timed-out mutation is never re-issued), a separate exec deadline distinct from the short control timeout (new `OPENGENI_SANDBOX_SELFHOSTED_EXEC_TIMEOUT_MS` / `OPENGENI_SANDBOX_SELFHOSTED_CONTROL_TIMEOUT_MS`, default 2min/30s), and actionable, human-language error copy for over-limit payloads, capacity backpressure, and exec-deadline termination.
- 0f10413: Make Connected Machine (selfhosted) faults legible to the agent in-band. The `exec_command` tool now returns a four-field rendering (what happened / which layer / what was preserved / what to try) with a correct retry verdict — machine-offline and consent faults no longer reach the model mislabelled "Please try again". PAYLOAD_TOO_LARGE is typed with a distinguishing flag and rendered with the size wall plus recovery moves (redirect to a file, read in chunks). A transient offline blip the transport KNOWS occurred pre-send (no connection / no responder — the op provably never reached the machine) now heals with a short bounded retry for any op kind, while an ambiguous post-send fault is never blindly re-issued.
- 3148404: Add a transport-agnostic per-op observation seam (`SelfhostedOpObserver`) to the Connected Machine control path, plus a metrics sink and the fault taxonomy for the `machine.op.*` session events. `SelfhostedSession.call` invokes an optional injected observer once per completed op with op-shaped telemetry (op kind, ok/failed outcome, healed-after-retry flag, retry count, typed code/reason, never-sent, duration, machine id, a stable `selfhostedFaultClass`, and reply bytes on a payload-wall fault). The observer is guarded so a telemetry sink can never break an op, and it is threaded through the sandbox client/build + routing resolver so the worker can wire it. `RuntimeMetricsHooks` gains `onSandboxOp` for op-outcome counters/histograms; `selfhostedFaultClass` + `SELFHOSTED_INFRASTRUCTURE_FAULT_CLASSES` single-source the class taxonomy that gates the `machine.op.*` events (infrastructure faults + healed recoveries only). The op-engine's future op-stream client emits through the same observer interface.
- 1d57c33: Keep Connected Machine control liveness responsive under bounded host work, propagate finite exec deadlines to the machine, and retry transient control-bus connection acquisition.
- a5f58f9: Make "stop" mean stop, and stop the child-completion flood from outrunning it.

  - **Stop drains the queue.** A non-steer interrupt now cancels the active turn AND all queued turns, emitting one `turn.queue_drained` summary event. Steer still promotes exactly one steered message.
  - **A user-paused goal is sacred.** A machine child-completion turn can no longer re-activate a goal the user paused (`goal_set` is refused for such callers), and the wake text drops the "resume it now" nudge when the manager's own goal is user-paused. The caller is classified by its own signed turn identity (a new `turnId` claim on the first-party MCP token), not the session's live active pointer — so the guard cannot be raced into refusing a legitimate human `goal_set`.
  - **Child-completion notifications coalesce.** N spawned workers reaching terminal states now fold into ONE queued digest turn (one model run) instead of N turns, so the flood can no longer outrun a human's stop button. Each worker still gets its own result card.
  - **Human messages preempt machine notifications.** A person's message jumps ahead of any queued child-completion notification turns (behind the running turn and earlier human turns) — it never waits behind a flood of "worker FAILED" notices.
  - **Child-completion suppression opt-in.** A new first-party `set_child_notifications_mode` tool lets a manager switch spawned-worker completions to `passive`: they appear as timeline cards only and never queue a turn or a model run. `digest` remains the default.
  - **Honest steering copy.** The composer no longer claims steer "injects this message now"; it cancels the current step and runs the message next while the goal continues, and the stop button says it clears queued messages and pauses the goal.

- 27a114c: Record a provider-reported `cached_tokens: 0` as 0 in model-call usage telemetry instead of null. The previous >0-only filter made "the provider cached nothing" indistinguishable from "no telemetry returned" — which is exactly how 10k+ genuinely-uncached Azure gpt-5.6 calls masqueraded as a telemetry gap during the 2026-07-12 incident forensics. Absent detail objects still record null (unknown). Pricing is unaffected (null and 0 both bill the uncached rate); dashboards gain an honest zero.
- 9d4283d: Per-workspace model/provider hard-block policy. A new `workspace_model_policies` table (NULL = unrestricted) lets a workspace strictly allowlist which providers and/or exact model ids may serve its turns. Enforced twice: a 422 at every API model choke point (user message, queued-turn update, scheduled task, and session creation — where the EFFECTIVE model, `payload.model ?? deployment default`, is vetted, since an omitted model stamps the deployment default onto the session), and authoritatively in the worker immediately after turn model resolution, where a blocked provider/model throws `WorkspaceModelPolicyBlockedError` before any model call — including the legacy null-resolution fallback to the built-in OpenAI/Azure client, which is attributed to the built-in's own provider id so blocking the built-in also closes that path. Goal continuations that inherit a blocked model recover to the session's allowed default or pause the goal visibly with a truthful rationale. New `GET/PUT /v1/workspaces/:workspaceId/model-policy` routes (read / admin) manage the policy. Workspaces without a policy row behave exactly as before. This exists so a codex-subscription workspace can be fail-closed to codex: a turn may wait or fail loud, but can never fall through to a paid provider.
- Updated dependencies [ad4502a]
- Updated dependencies [ec508d4]
- Updated dependencies [58c78c6]
- Updated dependencies [04d7595]
- Updated dependencies [0805620]
- Updated dependencies [faf1487]
- Updated dependencies [b125213]
- Updated dependencies [b804fd4]
- Updated dependencies [4a25bfc]
- Updated dependencies [3148404]
- Updated dependencies [a0cb58f]
- Updated dependencies [3584f26]
- Updated dependencies [e4d3569]
- Updated dependencies [5942493]
- Updated dependencies [726cf2c]
- Updated dependencies [a5f58f9]
- Updated dependencies [9d4283d]
  - @opengeni/config@0.5.0
  - @opengeni/codex@0.2.2
  - @opengeni/contracts@0.10.0
  - @opengeni/agent-proto@0.3.0

## 0.6.1

### Patch Changes

- ac924ca: Fix Modal private-registry sandbox image handling for embedded deployments and republish the observability API surface.

  Modal registry Secrets are resolved through the authenticated OpenGeni Modal client, and Modal private-registry images are now warmed at turn time for pack-scoped sandbox images, not only at worker boot for the deployment-global image ref.

  `@opengeni/observability` is minor-bumped so the already-source-shipped `setGauge`, `incrementCounter`, `observeHistogram`, and `debug` methods are available to external consumers. The published direct dependents are patch-bumped so their 0.x caret ranges resolve to the new observability minor in a coherent install.

## 0.6.0

### Minor Changes

- 1e7a243: Support PRIVATE-registry Modal sandbox images via `OPENGENI_MODAL_IMAGE_REGISTRY_SECRET`.

  The Agents-extension Modal backend resolves `OPENGENI_MODAL_IMAGE_REF` (and any pack
  `sandboxImage` that overrides it) with `Image.fromRegistry(tag)` and no secret, so it could
  only pull PUBLIC images. New optional setting `modalImageRegistrySecret` (env
  `OPENGENI_MODAL_IMAGE_REGISTRY_SECRET`) names a Modal Secret holding `REGISTRY_USERNAME` +
  `REGISTRY_PASSWORD`; when set, the runtime resolves that Secret and pre-builds
  `fromRegistry(tag, secret)` ONCE per worker process (`ensureModalRegistryImage`, awaited in
  `createOpenGeniWorker` boot) and the Modal provider selects it via
  `ModalImageSelector.fromImage(...)`. When unset the behavior is byte-identical to today's
  public-image path (and the modal SDK is never loaded for it). Resume/attach turns never pull
  the image, so they are unaffected.

### Patch Changes

- Updated dependencies [1e7a243]
  - @opengeni/config@0.4.0

## 0.5.0

### Minor Changes

- b34b912: Toolspace: selfhosted parity + generic programmatic-calling agent instructions.

  Connected-machine (selfhosted) turns now receive the toolspace token like every other backend. The git-token skip does not transfer: the platform GitHub token is inert on a user machine, but the toolspace token is the machine's only path to programmatic tool calling. It is safe to deliver because it grants no more than the machine owner's own authority — `toolspace:call` only, bound to its own session, turn TTL, budgeted, approval-tools excluded. Delivery mirrors the docker path: the token is seeded to `$OPENGENI_TOOLSPACE_TOKEN_FILE` over the machine's exec channel, off-manifest, targeting the public sandbox-routable API URL; the platform setup hooks (repository clone, az login) still never run against the user's machine.

  When a toolspace token is minted for a turn (feature enabled, any backend), the agent's composed instructions carry a short, generic substrate note: every MCP tool is also callable programmatically from the sandbox via `ogtool` (or MCP JSON-RPC to `$OPENGENI_TOOLSPACE_URL` with the bearer from `$OPENGENI_TOOLSPACE_TOKEN_FILE`), prefer programmatic calls for loops/polling/bulk filtering because those results do not consume model context, and approval-required tools must still be invoked normally. The note composes after the workspace persona + CORE but before the per-session instructions. The `@opengeni/core` and `@opengeni/api-router` bumps are the dependent-closure patch for the runtime minor.

## 0.4.0

### Minor Changes

- 602db89: Add Toolspace programmatic tool access for sandboxes.

  The new `toolspace:call` permission is an explicit, session-bound delegated grant for sandbox code. When `OPENGENI_TOOLSPACE_ENABLED=true`, worker turns mint a narrow `ogd_` token to a sandbox token file and expose `OPENGENI_TOOLSPACE_URL`; the first-party MCP route uses that token to compose the session's safe first-party, capability-backed, and per-session MCP tools, with approval-required tools denied as MCP `isError` results.

### Patch Changes

- Updated dependencies [602db89]
  - @opengeni/contracts@0.9.0
  - @opengeni/config@0.3.0

## 0.3.2

### Patch Changes

- Updated dependencies [7bfe593]
  - @opengeni/contracts@0.8.0
  - @opengeni/config@0.2.6

## 0.3.1

### Patch Changes

- Updated dependencies [5ca067f]
  - @opengeni/contracts@0.7.0
  - @opengeni/config@0.2.5

## 0.3.0

### Minor Changes

- e513236: Add an optional per-session `instructions` field to `CreateSessionRequest`: a first-class, system-level agent persona lever composed AFTER the per-workspace `agentInstructions` (session-specific last, non-bypassable CORE preserved). It is org-visible session metadata (returned on the session record) but is never emitted as a timeline event, so hosts can deliver per-agent-type prompts without leaking prompt content into the user-visible timeline or weakening instruction authority. Absent ⇒ byte-identical to today's composition.

### Patch Changes

- 3c223ca: Route unique bare registry model ids through their registry provider even when a run-scoped turn model matches `openaiModel`.
- Updated dependencies [dbe3a19]
- Updated dependencies [e513236]
  - @opengeni/config@0.2.4
  - @opengeni/contracts@0.6.0

## 0.2.3

### Patch Changes

- Updated dependencies [15deca0]
  - @opengeni/contracts@0.5.0
  - @opengeni/config@0.2.3

## 0.2.2

### Patch Changes

- 5962dd0: Republish the closure so published manifests reference `@opengeni/contracts@^0.4.0`. The previous `^0.3.0` ranges exclude 0.4.0 under 0.x caret semantics, causing consumers to nest a stale contracts copy that lacks the current export surface.
- Updated dependencies [5962dd0]
  - @opengeni/agent-proto@0.2.1
  - @opengeni/codex@0.2.1
  - @opengeni/config@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies [548e307]
  - @opengeni/contracts@0.4.0
  - @opengeni/config@0.2.1

## 0.2.0

### Minor Changes

- 2170732: Publish the full Stage C `@opengeni/*` runtime closure to npm so external hosts can consume OpenGeni from published packages instead of vendored workspace tarballs.

  The release pipeline now builds every publishable package, rewrites every published `workspace:*` dependency to a concrete semver range, rewrites source entry points to dist entry points for every publishable package, and leaves only leaf-only non-runtime packages ignored.

### Patch Changes

- Updated dependencies [2170732]
  - @opengeni/agent-proto@0.2.0
  - @opengeni/codex@0.2.0
  - @opengeni/config@0.2.0
