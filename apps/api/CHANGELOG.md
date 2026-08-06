# @opengeni/api-router

## 0.22.5

### Patch Changes

- 5d8bb99: Allow scheduled tasks to target and durably wake one authorized existing session without creating a helper session or replacing its goal.
- 238fb7e: Keep human-to-human Slack DM shortcuts initiating-user-private and route durable acknowledgements, progress, results, and replies through the invoking user's OpenGeni bot DM.
- 252095e: Keep durable composer voice recordings in automatic bounded recovery after transient failures, while requiring explicit insertion for every delayed or reload-recovered transcript.
- fb71b89: Anchor interval scheduled-task cadence to an explicit `startAt` instead of the Temporal epoch grid.
- Updated dependencies [b783f12]
- Updated dependencies [fc7cc08]
- Updated dependencies [ece124b]
- Updated dependencies [7a84e1b]
- Updated dependencies [5d8bb99]
- Updated dependencies [238fb7e]
- Updated dependencies [af24281]
  - @opengeni/runtime@0.18.20
  - @opengeni/core@0.21.5
  - @opengeni/db@0.28.4
  - @opengeni/contracts@0.39.3
  - @opengeni/config@0.11.3
  - @opengeni/documents@0.5.13
  - @opengeni/events@0.3.83
  - @opengeni/github@0.4.34
  - @opengeni/observability@0.5.3
  - @opengeni/storage@0.2.71

## 0.22.4

### Patch Changes

- 7dbd057: Preserve provider-defined repository clone paths and centralize provider-declared `.git` alias semantics across resource identity and credential routing.
- 30a0b9a: Preserve internal content exactly, replace heuristic rewriting with lossless persistence, and keep public telemetry on reviewed structural projections.
- c3876d4: Preserve sliding managed-session renewal cookies on protected API responses so active browser sessions do not expire at their original sign-in boundary.
- 23de73b: Add explicitly permissioned, audited plaintext reads for encrypted workspace variable-set values across REST, SDK, React, MCP, and UI surfaces.
- Updated dependencies [1fbb6e7]
- Updated dependencies [7dbd057]
- Updated dependencies [78a1577]
- Updated dependencies [30a0b9a]
- Updated dependencies [c3876d4]
- Updated dependencies [23de73b]
- Updated dependencies [1503151]
- Updated dependencies [0b23696]
- Updated dependencies [4c7b956]
- Updated dependencies [42c04ce]
- Updated dependencies [a296081]
  - @opengeni/runtime@0.18.19
  - @opengeni/contracts@0.39.2
  - @opengeni/core@0.21.4
  - @opengeni/observability@0.5.2
  - @opengeni/codex@0.2.12
  - @opengeni/db@0.28.3
  - @opengeni/events@0.3.82
  - @opengeni/config@0.11.2
  - @opengeni/documents@0.5.12
  - @opengeni/github@0.4.33
  - @opengeni/storage@0.2.70

## 0.22.3

### Patch Changes

- 5d1d0c2: Make browser live streams visibility-aware, share one routed session feed,
  bound reconciliation and heartbeat recovery, coalesce overlapping reads, and
  expose the append, publish, and SSE connection lifecycle in metrics.
- ce823ce: Replace first-party MCP mutation entity echoes with strict, versioned compact
  receipts; add bounded scheduled-task list/detail projections and preserve worker
  session references across receipt and legacy timeline results.
- Updated dependencies [110d255]
- Updated dependencies [41f7ae3]
- Updated dependencies [5d1d0c2]
- Updated dependencies [ce823ce]
  - @opengeni/db@0.28.2
  - @opengeni/core@0.21.3
  - @opengeni/runtime@0.18.18
  - @opengeni/events@0.3.81
  - @opengeni/contracts@0.39.1
  - @opengeni/documents@0.5.11
  - @opengeni/config@0.11.1
  - @opengeni/github@0.4.32
  - @opengeni/observability@0.5.1
  - @opengeni/storage@0.2.69

## 0.22.2

### Patch Changes

- Updated dependencies [33166b0]
  - @opengeni/observability@0.5.0
  - @opengeni/core@0.21.2

## 0.22.1

### Patch Changes

- Updated dependencies [55f6ad0]
- Updated dependencies [18eea76]
  - @opengeni/db@0.28.1
  - @opengeni/runtime@0.18.17
  - @opengeni/core@0.21.1
  - @opengeni/documents@0.5.10
  - @opengeni/events@0.3.80

## 0.22.0

### Minor Changes

- 6eb0b23: Add production resumable composer transcription with exact-subject durable
  manifests, idempotent SHA-256 chunk uploads, bounded ffmpeg segmentation, one
  recording-wide provider pin, persisted retryable segment results, deterministic
  assembly, cross-browser SDK recovery, object-ledger cleanup, and expiry purging
  of transcript metadata after every provider object is confirmed deleted. Legacy
  one-shot voice input remains compatible.

### Patch Changes

- 49c7f9c: Prevent deadlocks between sandbox mutation settlement and retained-process promotion, retry idempotent settlement transactions after transient database conflicts, and clarify that an idle session sandbox can be restored when the next operation needs it.
- Updated dependencies [49c7f9c]
- Updated dependencies [5b6d36e]
- Updated dependencies [6eb0b23]
- Updated dependencies [5b6d36e]
  - @opengeni/db@0.28.0
  - @opengeni/config@0.11.0
  - @opengeni/contracts@0.39.0
  - @opengeni/core@0.21.0
  - @opengeni/runtime@0.18.16
  - @opengeni/documents@0.5.9
  - @opengeni/events@0.3.79
  - @opengeni/github@0.4.31
  - @opengeni/storage@0.2.68
  - @opengeni/observability@0.4.17

## 0.21.15

### Patch Changes

- Updated dependencies [cbf165a]
  - @opengeni/db@0.27.12
  - @opengeni/core@0.20.17
  - @opengeni/documents@0.5.8
  - @opengeni/events@0.3.78

## 0.21.14

### Patch Changes

- Updated dependencies [8135dbb]
- Updated dependencies [17643a5]
  - @opengeni/config@0.10.14
  - @opengeni/db@0.27.11
  - @opengeni/core@0.20.16
  - @opengeni/documents@0.5.7
  - @opengeni/github@0.4.30
  - @opengeni/runtime@0.18.15
  - @opengeni/storage@0.2.67
  - @opengeni/events@0.3.77

## 0.21.13

### Patch Changes

- Updated dependencies [c6c9acb]
  - @opengeni/runtime@0.18.14
  - @opengeni/core@0.20.15

## 0.21.12

### Patch Changes

- 69bc207: Keep Codex history canonical across subscriptions and providers, separate optional owner-designated Codex Apps authority from inference allocation, and fence Apps authorization through each remote request.
- c0f8e40: Prevent model-visible GitHub installation credential exposure and duplicate brokered MCP side effects after ambiguous 401 responses.
- Updated dependencies [69bc207]
- Updated dependencies [144fd9e]
- Updated dependencies [c0f8e40]
  - @opengeni/codex@0.2.11
  - @opengeni/core@0.20.14
  - @opengeni/db@0.27.10
  - @opengeni/runtime@0.18.13
  - @opengeni/contracts@0.38.3
  - @opengeni/config@0.10.13
  - @opengeni/documents@0.5.6
  - @opengeni/events@0.3.76
  - @opengeni/github@0.4.29
  - @opengeni/observability@0.4.16
  - @opengeni/storage@0.2.66

## 0.21.11

### Patch Changes

- Updated dependencies [8105c25]
  - @opengeni/runtime@0.18.12
  - @opengeni/core@0.20.13

## 0.21.10

### Patch Changes

- 4502474: Add workspace-default and explicitly personal ownership for first-party social connections, preserve causal personal authority for agent work, and retain actionable structured gateway errors.
- Updated dependencies [4502474]
- Updated dependencies [1ea5e62]
- Updated dependencies [ee79969]
  - @opengeni/contracts@0.38.2
  - @opengeni/core@0.20.12
  - @opengeni/db@0.27.9
  - @opengeni/runtime@0.18.11
  - @opengeni/config@0.10.12
  - @opengeni/documents@0.5.5
  - @opengeni/events@0.3.75
  - @opengeni/github@0.4.28
  - @opengeni/observability@0.4.15
  - @opengeni/storage@0.2.65

## 0.21.9

### Patch Changes

- Updated dependencies [dfa3aef]
  - @opengeni/core@0.20.11
  - @opengeni/db@0.27.8
  - @opengeni/documents@0.5.4
  - @opengeni/events@0.3.74

## 0.21.8

### Patch Changes

- 8c9b9a7: Return actionable operator configuration guidance when social OAuth credentials are missing.

## 0.21.7

### Patch Changes

- c29fd4c: Bound MCP OAuth callbacks through token exchange and persistence, return safe stage-specific failures to the capabilities UI, and replace incompatible dynamic client registrations with a compare-and-swap update.
- Updated dependencies [c29fd4c]
  - @opengeni/core@0.20.10
  - @opengeni/db@0.27.7
  - @opengeni/documents@0.5.3
  - @opengeni/events@0.3.73

## 0.21.6

### Patch Changes

- Updated dependencies [664c1d8]
  - @opengeni/network@0.2.0
  - @opengeni/core@0.20.9
  - @opengeni/db@0.27.6
  - @opengeni/runtime@0.18.10
  - @opengeni/documents@0.5.2
  - @opengeni/events@0.3.72

## 0.21.5

### Patch Changes

- Updated dependencies [c9d8b69]
  - @opengeni/contracts@0.38.1
  - @opengeni/db@0.27.5
  - @opengeni/config@0.10.11
  - @opengeni/core@0.20.8
  - @opengeni/documents@0.5.1
  - @opengeni/events@0.3.71
  - @opengeni/github@0.4.27
  - @opengeni/observability@0.4.14
  - @opengeni/runtime@0.18.9
  - @opengeni/storage@0.2.64

## 0.21.4

### Patch Changes

- Updated dependencies [b6e39fc]
- Updated dependencies [bef5920]
  - @opengeni/db@0.27.4
  - @opengeni/config@0.10.10
  - @opengeni/contracts@0.38.0
  - @opengeni/documents@0.5.0
  - @opengeni/core@0.20.7
  - @opengeni/events@0.3.70
  - @opengeni/github@0.4.26
  - @opengeni/runtime@0.18.8
  - @opengeni/storage@0.2.63
  - @opengeni/observability@0.4.13

## 0.21.3

### Patch Changes

- Updated dependencies [d5df927]
- Updated dependencies [4976e1c]
  - @opengeni/documents@0.4.1
  - @opengeni/core@0.20.6
  - @opengeni/network@0.1.2
  - @opengeni/db@0.27.3
  - @opengeni/runtime@0.18.7
  - @opengeni/events@0.3.69

## 0.21.2

### Patch Changes

- Updated dependencies [fd13ba9]
  - @opengeni/contracts@0.37.0
  - @opengeni/documents@0.4.0
  - @opengeni/config@0.10.9
  - @opengeni/core@0.20.5
  - @opengeni/db@0.27.2
  - @opengeni/events@0.3.68
  - @opengeni/github@0.4.25
  - @opengeni/observability@0.4.12
  - @opengeni/runtime@0.18.6
  - @opengeni/storage@0.2.62

## 0.21.1

### Patch Changes

- Updated dependencies [abe0de6]
  - @opengeni/config@0.10.8
  - @opengeni/contracts@0.36.1
  - @opengeni/core@0.20.4
  - @opengeni/db@0.27.1
  - @opengeni/documents@0.3.4
  - @opengeni/github@0.4.24
  - @opengeni/runtime@0.18.5
  - @opengeni/storage@0.2.61
  - @opengeni/events@0.3.67
  - @opengeni/observability@0.4.11

## 0.21.0

### Minor Changes

- 00f7d3b: Add durable, tenant-isolated onboarding proposals that atomically create inactive instruction-policy drafts with typed replay, stale-baseline, conflict, and audit contracts, plus a bounded Workspace State admin composer.

### Patch Changes

- Updated dependencies [00f7d3b]
  - @opengeni/contracts@0.36.0
  - @opengeni/db@0.27.0
  - @opengeni/config@0.10.7
  - @opengeni/core@0.20.3
  - @opengeni/documents@0.3.3
  - @opengeni/events@0.3.66
  - @opengeni/github@0.4.23
  - @opengeni/observability@0.4.10
  - @opengeni/runtime@0.18.4
  - @opengeni/storage@0.2.60

## 0.20.0

### Minor Changes

- b121e7c: Add durable Google Drive pause, resume, disconnect, reconnect, revoked-token,
  removed-app, and permission re-consent lifecycle handling with version-fenced
  state transitions, generation-bound disconnect idempotency, stale-replay
  protection, and secret-safe provider error classification.

### Patch Changes

- Updated dependencies [b121e7c]
  - @opengeni/contracts@0.35.0
  - @opengeni/db@0.26.0
  - @opengeni/config@0.10.6
  - @opengeni/core@0.20.2
  - @opengeni/documents@0.3.2
  - @opengeni/events@0.3.65
  - @opengeni/github@0.4.22
  - @opengeni/observability@0.4.9
  - @opengeni/runtime@0.18.3
  - @opengeni/storage@0.2.59

## 0.19.0

### Minor Changes

- b83af7a: Add replay-safe workspace instruction policy administration across the API,
  contracts, database, and SDK, including immutable operation receipts that reject
  changed requests reusing the same operation identifier.

### Patch Changes

- Updated dependencies [b83af7a]
  - @opengeni/contracts@0.34.0
  - @opengeni/db@0.25.0
  - @opengeni/config@0.10.5
  - @opengeni/core@0.20.1
  - @opengeni/documents@0.3.1
  - @opengeni/events@0.3.64
  - @opengeni/github@0.4.21
  - @opengeni/observability@0.4.8
  - @opengeni/runtime@0.18.2
  - @opengeni/storage@0.2.58

## 0.18.0

### Minor Changes

- 3e4842d: Add subject-authorized accepted-attempt governance inspection to Workspace State,
  including immutable policy/preference snapshot metadata and deterministic current
  drift classification without exposing prompt or personal preference content.

### Patch Changes

- d1f0c3d: Add immutable organization, workspace, and initiating-user personal authority to Documents and chunks; filter retrieval by exact account and authority before ranking; require exact account-admin authority for organization publication; and preserve authority through a drained API, worker, and indexing-workflow cutover.
- 1d0f2ae: Expose one effective document retrieval contract across REST, SDK, and MCP that binds the immutable initiating subject outside caller input, filters organization/workspace/personal authority before ranking, and preserves source plus authorization provenance in typed results.
- Updated dependencies [d1f0c3d]
- Updated dependencies [1d0f2ae]
- Updated dependencies [088d7cb]
- Updated dependencies [74bd3a5]
- Updated dependencies [3e4842d]
  - @opengeni/contracts@0.33.0
  - @opengeni/documents@0.3.0
  - @opengeni/core@0.20.0
  - @opengeni/db@0.24.0
  - @opengeni/config@0.10.4
  - @opengeni/runtime@0.18.1
  - @opengeni/events@0.3.63
  - @opengeni/github@0.4.20
  - @opengeni/observability@0.4.7
  - @opengeni/storage@0.2.57

## 0.17.0

### Minor Changes

- e03397d: Freeze workspace instruction policies and structured preference descriptors at
  the accepted logical-turn boundary, add immutable per-session policy roles, and
  compose the resulting exact-attempt governance into agent and compaction prompts.

### Patch Changes

- ecc4288: Add a deterministic, fail-closed Google Drive OAuth scope-capability contract and
  require recursive selected-source read access before callback persistence or
  source browsing.
- 4f15920: Add an authorized, server-mediated connected-Codex GPT-Live V3 WebRTC SDP path with credential-safe negotiation and browser lifecycle helpers.
- acfcf38: Preserve one durable task per distinct authorized Slack reaction when concurrent events share a canonical session, including route-bind, acknowledgement, and inbox-settlement recovery.
- Updated dependencies [13b961e]
- Updated dependencies [ecc4288]
- Updated dependencies [e03397d]
- Updated dependencies [4f15920]
- Updated dependencies [acfcf38]
- Updated dependencies [3baaebd]
  - @opengeni/contracts@0.32.0
  - @opengeni/core@0.19.0
  - @opengeni/db@0.23.0
  - @opengeni/runtime@0.18.0
  - @opengeni/codex@0.2.10
  - @opengeni/config@0.10.3
  - @opengeni/documents@0.2.72
  - @opengeni/events@0.3.62
  - @opengeni/github@0.4.19
  - @opengeni/observability@0.4.6
  - @opengeni/storage@0.2.56

## 0.16.6

### Patch Changes

- Updated dependencies [e62495f]
- Updated dependencies [b4982fa]
- Updated dependencies [b4982fa]
- Updated dependencies [70e6d56]
  - @opengeni/contracts@0.31.2
  - @opengeni/core@0.18.2
  - @opengeni/config@0.10.2
  - @opengeni/runtime@0.17.2
  - @opengeni/db@0.22.3
  - @opengeni/documents@0.2.71
  - @opengeni/events@0.3.61
  - @opengeni/github@0.4.18
  - @opengeni/observability@0.4.5
  - @opengeni/storage@0.2.55

## 0.16.5

### Patch Changes

- 9c4d73d: Add curated OpenGeni-credit and workspace-key Vercel AI Gateway model paths for
  DeepSeek V4 Flash and Kimi K3, including exact provider routing, cache-aware
  pricing and metering, Responses tool continuity, provider-blind catalog UX, and
  stable remote-compaction cache prefixes.
- Updated dependencies [9c4d73d]
  - @opengeni/config@0.10.1
  - @opengeni/contracts@0.31.1
  - @opengeni/core@0.18.1
  - @opengeni/db@0.22.2
  - @opengeni/runtime@0.17.1
  - @opengeni/documents@0.2.70
  - @opengeni/github@0.4.17
  - @opengeni/storage@0.2.54
  - @opengeni/events@0.3.60
  - @opengeni/observability@0.4.4

## 0.16.4

### Patch Changes

- Updated dependencies [8b3e46f]
  - @opengeni/config@0.10.0
  - @opengeni/contracts@0.31.0
  - @opengeni/core@0.18.0
  - @opengeni/runtime@0.17.0
  - @opengeni/db@0.22.1
  - @opengeni/documents@0.2.69
  - @opengeni/github@0.4.16
  - @opengeni/storage@0.2.53
  - @opengeni/events@0.3.59
  - @opengeni/observability@0.4.3

## 0.16.3

### Patch Changes

- e07eb52: Enforce frozen Allow, Ask, and Block connector action policies before provider execution while persisting metadata-only approval, decision, and outcome evidence.
- Updated dependencies [e07eb52]
- Updated dependencies [c4a0031]
- Updated dependencies [4fcb6af]
  - @opengeni/db@0.22.0
  - @opengeni/runtime@0.16.3
  - @opengeni/core@0.17.3
  - @opengeni/documents@0.2.68
  - @opengeni/events@0.3.58

## 0.16.2

### Patch Changes

- 6500589: Automatically restore and list each workspace's Default document collection so uploads no longer require creating a base first, while preserving existing base-specific APIs and optional collection organization.
- Updated dependencies [6500589]
  - @opengeni/documents@0.2.67
  - @opengeni/core@0.17.2

## 0.16.1

### Patch Changes

- Updated dependencies [2321119]
  - @opengeni/contracts@0.30.0
  - @opengeni/db@0.21.0
  - @opengeni/config@0.9.3
  - @opengeni/core@0.17.1
  - @opengeni/documents@0.2.66
  - @opengeni/events@0.3.57
  - @opengeni/github@0.4.15
  - @opengeni/observability@0.4.2
  - @opengeni/runtime@0.16.2
  - @opengeni/storage@0.2.52

## 0.16.0

### Minor Changes

- dd71248: Make workspace-owned MCP OAuth connections the default, add explicit personal
  connection ownership, and preserve exact delegated personal authority across
  turns, child sessions, goals, schedules, retries, and recovery with safe
  tool-level degradation when a personal connection is unavailable.

### Patch Changes

- 03ed7eb: Preserve the linked Slack user's latest effective browser-selected turn model for inbound tasks and surface bounded session admission failures in Slack.
- Updated dependencies [f4fa05c]
- Updated dependencies [dd71248]
- Updated dependencies [03ed7eb]
  - @opengeni/runtime@0.16.1
  - @opengeni/contracts@0.29.0
  - @opengeni/core@0.17.0
  - @opengeni/db@0.20.0
  - @opengeni/config@0.9.2
  - @opengeni/documents@0.2.65
  - @opengeni/events@0.3.56
  - @opengeni/github@0.4.14
  - @opengeni/observability@0.4.1
  - @opengeni/storage@0.2.51

## 0.15.6

### Patch Changes

- Updated dependencies [38ba6bc]
  - @opengeni/observability@0.4.0
  - @opengeni/runtime@0.16.0
  - @opengeni/core@0.16.3

## 0.15.5

### Patch Changes

- 3035b59: Publish regression coverage for Slack interaction durability, permanent preflight rejection, and read-only context-tool policy.
- Updated dependencies [1a2d41f]
  - @opengeni/db@0.19.0
  - @opengeni/core@0.16.2
  - @opengeni/documents@0.2.64
  - @opengeni/events@0.3.55

## 0.15.4

### Patch Changes

- 8ffa77e: Compress large JSON API responses and serve the production web application with precompressed, immutable hashed assets.

## 0.15.3

### Patch Changes

- 659b3ff: Harden Slack-triggered session delivery, identity linking, provider backoff, explicit connection-tool selection, and replay-safe bounded progress/final delivery.
- Updated dependencies [659b3ff]
  - @opengeni/contracts@0.28.1
  - @opengeni/db@0.18.1
  - @opengeni/config@0.9.1
  - @opengeni/core@0.16.1
  - @opengeni/documents@0.2.63
  - @opengeni/events@0.3.54
  - @opengeni/github@0.4.13
  - @opengeni/runtime@0.15.3
  - @opengeni/storage@0.2.50

## 0.15.2

### Patch Changes

- d4d8960: Keep Personal Slack UI, reconnect, and broker credential selection on one deterministic legacy-duplicate ordering.
- Updated dependencies [d4d8960]
- Updated dependencies [ec0bc02]
- Updated dependencies [3b8d653]
- Updated dependencies [5a4c559]
  - @opengeni/contracts@0.28.0
  - @opengeni/db@0.18.0
  - @opengeni/config@0.9.0
  - @opengeni/runtime@0.15.2
  - @opengeni/core@0.16.0
  - @opengeni/documents@0.2.62
  - @opengeni/events@0.3.53
  - @opengeni/github@0.4.12
  - @opengeni/storage@0.2.49

## 0.15.1

### Patch Changes

- 8243ffe: Allow browser SDK clients to call the public API from arbitrary origins with explicit bearer credentials while keeping cross-origin cookie sessions limited to operator-configured trusted origins.
- Updated dependencies [8243ffe]
  - @opengeni/config@0.8.1
  - @opengeni/core@0.15.1
  - @opengeni/db@0.17.1
  - @opengeni/documents@0.2.61
  - @opengeni/github@0.4.11
  - @opengeni/runtime@0.15.1
  - @opengeni/storage@0.2.48
  - @opengeni/events@0.3.52

## 0.15.0

### Minor Changes

- 1ec9912: Add generic, versioned workspace artifacts with content-addressed HTML storage, a static HTML/CSS renderer, rollback history, and first-party agent publishing tools. JavaScript and active or navigation-capable markup are removed from the initial renderer until executable artifacts have a stronger isolation boundary.

### Patch Changes

- Updated dependencies [dcc35c5]
- Updated dependencies [1ec9912]
  - @opengeni/config@0.8.0
  - @opengeni/contracts@0.27.0
  - @opengeni/core@0.15.0
  - @opengeni/db@0.17.0
  - @opengeni/runtime@0.15.0
  - @opengeni/documents@0.2.60
  - @opengeni/github@0.4.10
  - @opengeni/storage@0.2.47
  - @opengeni/events@0.3.51

## 0.14.4

### Patch Changes

- Updated dependencies [cb4d78d]
  - @opengeni/runtime@0.14.16
  - @opengeni/core@0.14.4

## 0.14.3

### Patch Changes

- Updated dependencies [c52acc0]
  - @opengeni/codex@0.2.9
  - @opengeni/config@0.7.22
  - @opengeni/contracts@0.26.1
  - @opengeni/core@0.14.3
  - @opengeni/db@0.16.2
  - @opengeni/runtime@0.14.15
  - @opengeni/documents@0.2.59
  - @opengeni/github@0.4.9
  - @opengeni/storage@0.2.46
  - @opengeni/events@0.3.50

## 0.14.2

### Patch Changes

- Updated dependencies [11cdf20]
  - @opengeni/runtime@0.14.14
  - @opengeni/core@0.14.2

## 0.14.1

### Patch Changes

- Updated dependencies [02fb98c]
  - @opengeni/db@0.16.1
  - @opengeni/core@0.14.1
  - @opengeni/documents@0.2.58
  - @opengeni/events@0.3.49

## 0.14.0

### Minor Changes

- f413e6c: Add real Workspace Insights: durable `model_call_facts` after authoritative
  `agent.model.usage`, a `workspace:admin` insights API over usage_events + facts +
  live joins, SDK client, and a web console that drops mock rollups for honest
  UTC credit/token/cache/warm/caps reporting.

### Patch Changes

- Updated dependencies [b5175a8]
- Updated dependencies [f413e6c]
  - @opengeni/db@0.16.0
  - @opengeni/contracts@0.26.0
  - @opengeni/core@0.14.0
  - @opengeni/documents@0.2.57
  - @opengeni/events@0.3.48
  - @opengeni/config@0.7.21
  - @opengeni/github@0.4.8
  - @opengeni/runtime@0.14.13
  - @opengeni/storage@0.2.45

## 0.13.6

### Patch Changes

- 0199108: Harden the workspace Slack bot with one fail-closed scope policy, deterministic legacy connection selection, and durable replay-safe message deletion operation identities.
- 42428a2: Add per-session Codex remote compaction v2 (`remote_v2` / `portable`), with UI landmarks, Codex-only model locking, and opaque token accounting aligned to Codex CLI.
- 7b65614: Keep over-limit viewer-only sandboxes drained until a fresh serialized balance
  or monthly-cap evaluation clears a durable workspace admission gate. Viewer
  reattach can no longer re-arm a draining box or spawn a cold successor, while a
  turn-held sandbox remains viewable.
- Updated dependencies [0199108]
- Updated dependencies [42428a2]
- Updated dependencies [7b65614]
- Updated dependencies [b2e975f]
- Updated dependencies [9f3b931]
  - @opengeni/contracts@0.25.0
  - @opengeni/core@0.13.10
  - @opengeni/db@0.15.6
  - @opengeni/runtime@0.14.12
  - @opengeni/config@0.7.20
  - @opengeni/github@0.4.7
  - @opengeni/storage@0.2.44
  - @opengeni/documents@0.2.56
  - @opengeni/events@0.3.47

## Unreleased

### Minor Changes

- Add server-side native voice-input transcription with OpenAI, Azure OpenAI, and gated experimental Codex subscription providers.
- Prefer Codex STT when subscription routing is enabled and a workspace has an
  active attached Codex credential; fall through to OpenAI/Azure when none is
  attached. Drop the unauthenticated Cloudflare HEAD probe.

## 0.13.5

### Patch Changes

- e19ba28: Prefer dynamic client registration for Linear MCP authorization when Linear advertises both DCR and Client ID Metadata Documents.
- Updated dependencies [710b081]
- Updated dependencies [b7df541]
  - @opengeni/core@0.13.9
  - @opengeni/contracts@0.24.3
  - @opengeni/config@0.7.19
  - @opengeni/db@0.15.5
  - @opengeni/runtime@0.14.11
  - @opengeni/documents@0.2.55
  - @opengeni/events@0.3.46
  - @opengeni/github@0.4.6
  - @opengeni/storage@0.2.43

## 0.13.4

### Patch Changes

- Updated dependencies [84fb671]
- Updated dependencies [96eb64b]
  - @opengeni/db@0.15.4
  - @opengeni/config@0.7.18
  - @opengeni/contracts@0.24.2
  - @opengeni/github@0.4.5
  - @opengeni/runtime@0.14.10
  - @opengeni/storage@0.2.42
  - @opengeni/core@0.13.8
  - @opengeni/documents@0.2.54
  - @opengeni/events@0.3.45

## 0.13.3

### Patch Changes

- Updated dependencies [510eae3]
  - @opengeni/db@0.15.3
  - @opengeni/core@0.13.7
  - @opengeni/documents@0.2.53
  - @opengeni/events@0.3.44

## 0.13.2

### Patch Changes

- 387cb73: Return the canonical validation envelope when a knowledge-search request exceeds the maximum result limit.
- ddff8db: Add the read-only Workspace State inventory with bounded, authorization-scoped
  Documents aggregates and a deterministic metadata-only Memory projection. The
  projection explicitly labels legacy `knowledge_memories` preference-kind counts
  as non-authoritative observations while preserving the structured preference
  registry as the sole active preference authority.
- Updated dependencies [3450ee5]
- Updated dependencies [ddff8db]
- Updated dependencies [0a9a6eb]
  - @opengeni/runtime@0.14.9
  - @opengeni/contracts@0.24.1
  - @opengeni/db@0.15.2
  - @opengeni/documents@0.2.52
  - @opengeni/config@0.7.17
  - @opengeni/storage@0.2.41
  - @opengeni/core@0.13.6
  - @opengeni/events@0.3.43
  - @opengeni/github@0.4.4

## 0.13.1

### Patch Changes

- Updated dependencies [6d167f4]
  - @opengeni/codex@0.2.8
  - @opengeni/db@0.15.1
  - @opengeni/config@0.7.16
  - @opengeni/core@0.13.5
  - @opengeni/runtime@0.14.8
  - @opengeni/documents@0.2.51
  - @opengeni/events@0.3.42
  - @opengeni/github@0.4.3
  - @opengeni/storage@0.2.40

## 0.13.0

### Minor Changes

- 1f6f13f: Add the isolated, versioned organization/workspace/user preference registry,
  including audited proposal and activation flows, deterministic attempt-bound
  descriptors, authorized full-content retrieval, REST/MCP tools, and SDK types.
  Attempt reads revalidate current generation and immutable-human authority in one
  locked transaction; lifecycle writes use scope-version CAS and database-owned
  audit functions that prevent direct head mutation or history erasure. Snapshot
  creation is database-canonical and lifecycle governance requires a signed
  `human_session` principal; expiry filtering and supersession are transactionally
  enforced before bounds or terminal mutation.

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
  - @opengeni/db@0.15.0
  - @opengeni/runtime@0.14.7
  - @opengeni/core@0.13.4
  - @opengeni/documents@0.2.50
  - @opengeni/github@0.4.2
  - @opengeni/storage@0.2.39
  - @opengeni/events@0.3.41

## 0.12.16

### Patch Changes

- Updated dependencies [848287f]
- Updated dependencies [2a7900f]
- Updated dependencies [821f664]
  - @opengeni/db@0.14.7
  - @opengeni/runtime@0.14.6
  - @opengeni/core@0.13.3
  - @opengeni/documents@0.2.49
  - @opengeni/events@0.3.40

## 0.12.15

### Patch Changes

- Updated dependencies [2aca964]
  - @opengeni/db@0.14.6
  - @opengeni/core@0.13.2
  - @opengeni/documents@0.2.48
  - @opengeni/events@0.3.39

## 0.12.14

### Patch Changes

- ad0bdc3: Surface managed-credit admission rejections with actionable composer recovery guidance while preserving drafts and attachments, and canonicalize default attachment mounts across established-session draft admission and replay.
- Updated dependencies [ad0bdc3]
  - @opengeni/contracts@0.23.1
  - @opengeni/db@0.14.5
  - @opengeni/config@0.7.14
  - @opengeni/core@0.13.1
  - @opengeni/documents@0.2.47
  - @opengeni/events@0.3.38
  - @opengeni/github@0.4.1
  - @opengeni/runtime@0.14.5
  - @opengeni/storage@0.2.38

## 0.12.13

### Patch Changes

- 39b1b84: Keep MCP request timeouts distinct from recoverable connection authentication errors.
- bcb50cf: Thread the configured Connected Machine control and exec deadlines through
  `run_on`, and return truthful typed timeout/deadline command receipts without
  replaying ambiguous execution.
- Updated dependencies [ea38a4c]
- Updated dependencies [39b1b84]
- Updated dependencies [1973d2a]
- Updated dependencies [bcb50cf]
- Updated dependencies [8478e60]
  - @opengeni/db@0.14.4
  - @opengeni/runtime@0.14.4
  - @opengeni/core@0.13.0
  - @opengeni/documents@0.2.46
  - @opengeni/events@0.3.37

## 0.12.12

### Patch Changes

- Updated dependencies [33dc88f]
- Updated dependencies [36451c6]
  - @opengeni/contracts@0.23.0
  - @opengeni/github@0.4.0
  - @opengeni/config@0.7.13
  - @opengeni/runtime@0.14.3
  - @opengeni/core@0.12.10
  - @opengeni/db@0.14.3
  - @opengeni/documents@0.2.45
  - @opengeni/events@0.3.36
  - @opengeni/storage@0.2.37

## 0.12.11

### Patch Changes

- 47a0927: Authorize first-party MCP Pause, Resume, and Agent Steer commands exactly once at the canonical command boundary instead of repeating the embedding host authorization call before persistence.
- 1c4018e: Replace one-turn tool overrides with one durable session tool policy, expose
  OpenGeni-native tools in the same selection, default available tools on, and
  render delivered machine inputs as compact typed timeline updates instead of
  raw protocol JSON.
- Updated dependencies [47a0927]
- Updated dependencies [1c4018e]
  - @opengeni/core@0.12.9
  - @opengeni/config@0.7.12
  - @opengeni/contracts@0.22.1
  - @opengeni/db@0.14.2
  - @opengeni/documents@0.2.44
  - @opengeni/github@0.3.24
  - @opengeni/runtime@0.14.2
  - @opengeni/storage@0.2.36
  - @opengeni/events@0.3.35

## 0.12.10

### Patch Changes

- 83db425: Reuse the already-validated inline workspace-capture response for an immutable capture revision instead of repeating full manifest schema validation on every poll.

## 0.12.9

### Patch Changes

- 6908a7a: Resolve session existence and the latest workspace capture in one RLS-scoped query so capture metadata requests avoid loading the full session projection.
- Updated dependencies [6908a7a]
  - @opengeni/db@0.14.1
  - @opengeni/core@0.12.8
  - @opengeni/documents@0.2.43
  - @opengeni/events@0.3.34

## 0.12.8

### Patch Changes

- 37bb6f7: Cache validated immutable workspace-capture manifests within strict process-local memory bounds.

## 0.12.7

### Patch Changes

- Updated dependencies [f2eebc8]
  - @opengeni/core@0.12.7

## 0.12.6

### Patch Changes

- dfc3235: Separate first-party MCP authorization from exact per-session tool visibility, add fail-closed registration policy, and isolate file download URLs on the files MCP surface.
- Updated dependencies [29ad09b]
- Updated dependencies [b2e23f3]
- Updated dependencies [dfc3235]
  - @opengeni/contracts@0.22.0
  - @opengeni/db@0.14.0
  - @opengeni/runtime@0.14.1
  - @opengeni/config@0.7.11
  - @opengeni/core@0.12.6
  - @opengeni/documents@0.2.42
  - @opengeni/events@0.3.33
  - @opengeni/github@0.3.23
  - @opengeni/storage@0.2.35

## 0.12.5

### Patch Changes

- 519d93c: Add validated inline per-session skills and discover skills directly from already-materialized repository resources.
- Updated dependencies [519d93c]
- Updated dependencies [7b962a6]
  - @opengeni/contracts@0.21.0
  - @opengeni/runtime@0.14.0
  - @opengeni/config@0.7.10
  - @opengeni/core@0.12.5
  - @opengeni/db@0.13.4
  - @opengeni/documents@0.2.41
  - @opengeni/events@0.3.32
  - @opengeni/github@0.3.22
  - @opengeni/storage@0.2.34

## 0.12.4

### Patch Changes

- 110bb77: Enforce exact-subject ownership for personal OAuth capabilities and add secure direct OAuth installation for the separate workspace OpenGeni Slack bot.
- Updated dependencies [110bb77]
  - @opengeni/config@0.7.9
  - @opengeni/contracts@0.20.2
  - @opengeni/core@0.12.4
  - @opengeni/db@0.13.3
  - @opengeni/runtime@0.13.14
  - @opengeni/documents@0.2.40
  - @opengeni/github@0.3.21
  - @opengeni/storage@0.2.33
  - @opengeni/events@0.3.31

## 0.12.3

### Patch Changes

- Updated dependencies [8b8545e]
  - @opengeni/db@0.13.2
  - @opengeni/core@0.12.3
  - @opengeni/documents@0.2.39
  - @opengeni/events@0.3.30

## 0.12.2

### Patch Changes

- f92af07: Keep Toolspace MCP networking portable under Bun and return a valid empty `tools/list` result when no programmatic tools are currently available.
- Updated dependencies [f92af07]
  - @opengeni/runtime@0.13.13
  - @opengeni/core@0.12.2

## 0.12.1

### Patch Changes

- Updated dependencies [ffd246c]
  - @opengeni/contracts@0.20.1
  - @opengeni/runtime@0.13.12
  - @opengeni/config@0.7.8
  - @opengeni/core@0.12.1
  - @opengeni/db@0.13.1
  - @opengeni/documents@0.2.38
  - @opengeni/events@0.3.29
  - @opengeni/github@0.3.20
  - @opengeni/storage@0.2.32

## 0.12.0

### Minor Changes

- 06a5801: Add the backend workspace instruction-policy revision, activation, rollback, audit, API, and SDK control surface.
- 5511c24: Add a secure workspace-shared OpenGeni Slack bot connection with schema-backed verified-install eligibility, immutable team/bot identity across reinstall, idempotent post-operation convergence, exact scope validation, first-party channel/history/user/post tools, explicit scheduled-task routing and rebinding, and install/reinstall/recovery UI and documentation.

### Patch Changes

- fd764e0: Route direct file, Git, and terminal calls to a machine-targeted session from the first request without creating a phantom provider lease, and make token-driven agent installation replace stale enrollment credentials.
- Updated dependencies [06a5801]
- Updated dependencies [9326255]
- Updated dependencies [fd764e0]
- Updated dependencies [5511c24]
  - @opengeni/contracts@0.20.0
  - @opengeni/db@0.13.0
  - @opengeni/config@0.7.7
  - @opengeni/core@0.12.0
  - @opengeni/documents@0.2.37
  - @opengeni/events@0.3.28
  - @opengeni/github@0.3.19
  - @opengeni/runtime@0.13.11
  - @opengeni/storage@0.2.31

## 0.11.8

### Patch Changes

- Updated dependencies [9a8f793]
- Updated dependencies [c135339]
- Updated dependencies [543bb26]
- Updated dependencies [8356146]
  - @opengeni/contracts@0.19.4
  - @opengeni/db@0.12.6
  - @opengeni/github@0.3.18
  - @opengeni/core@0.11.8
  - @opengeni/runtime@0.13.10
  - @opengeni/config@0.7.6
  - @opengeni/documents@0.2.36
  - @opengeni/events@0.3.27
  - @opengeni/storage@0.2.30

## 0.11.7

### Patch Changes

- a0f2442: Return typed correlation-safe API failures, discard bounded non-JSON gateway bodies in the SDK, preserve retryability and ambiguous mutation outcomes, and keep composer drafts stable across transient failures and live policy rerenders.
- Updated dependencies [a0f2442]
  - @opengeni/contracts@0.19.3
  - @opengeni/config@0.7.5
  - @opengeni/core@0.11.7
  - @opengeni/db@0.12.5
  - @opengeni/documents@0.2.35
  - @opengeni/events@0.3.26
  - @opengeni/github@0.3.17
  - @opengeni/runtime@0.13.9
  - @opengeni/storage@0.2.29

## 0.11.6

### Patch Changes

- Updated dependencies [85cb323]
  - @opengeni/config@0.7.4
  - @opengeni/contracts@0.19.2
  - @opengeni/core@0.11.6
  - @opengeni/db@0.12.4
  - @opengeni/documents@0.2.34
  - @opengeni/github@0.3.16
  - @opengeni/runtime@0.13.8
  - @opengeni/storage@0.2.28
  - @opengeni/events@0.3.25

## 0.11.5

### Patch Changes

- Updated dependencies [1386679]
- Updated dependencies [b7290a3]
- Updated dependencies [dcde939]
- Updated dependencies [5685f32]
- Updated dependencies [de20184]
  - @opengeni/db@0.12.3
  - @opengeni/runtime@0.13.7
  - @opengeni/config@0.7.3
  - @opengeni/contracts@0.19.1
  - @opengeni/core@0.11.5
  - @opengeni/documents@0.2.33
  - @opengeni/events@0.3.24
  - @opengeni/github@0.3.15
  - @opengeni/storage@0.2.27

## 0.11.4

### Patch Changes

- Updated dependencies [7c6aa7c]
  - @opengeni/config@0.7.2
  - @opengeni/db@0.12.2
  - @opengeni/core@0.11.4
  - @opengeni/documents@0.2.32
  - @opengeni/github@0.3.14
  - @opengeni/runtime@0.13.6
  - @opengeni/storage@0.2.26
  - @opengeni/events@0.3.23

## 0.11.3

### Patch Changes

- Updated dependencies [d03ee4b]
  - @opengeni/runtime@0.13.5
  - @opengeni/core@0.11.3

## 0.11.2

### Patch Changes

- 55c6559: Retain release-capable source heads with immutable GitHub prereleases and make
  the unbaked agent installer resolve through an explicitly configured stable
  version instead of a mutable release alias.
- Updated dependencies [55c6559]
- Updated dependencies [ac20b93]
  - @opengeni/config@0.7.1
  - @opengeni/runtime@0.13.4
  - @opengeni/core@0.11.2
  - @opengeni/db@0.12.1
  - @opengeni/documents@0.2.31
  - @opengeni/github@0.3.13
  - @opengeni/storage@0.2.25
  - @opengeni/events@0.3.22

## 0.11.1

### Patch Changes

- Updated dependencies [43e3503]
  - @opengeni/runtime@0.13.3
  - @opengeni/core@0.11.1

## 0.11.0

### Minor Changes

- 46bac05: Enforce a configurable inclusive nested-agent depth at the transactional
  session-creation boundary with a server default of three. Persist immutable
  lineage and policy snapshots, and return idempotent typed denial evidence without
  creating run, workflow, sandbox, usage, or billing artifacts.

### Patch Changes

- c549ed8: Persist and transactionally materialize revisioned active-goal continuation
  obligations, recover their Temporal delivery without human input or model
  polling, preserve authoritative human/Steer ordering, and expose truthful
  scheduled, running, blocked, and invariant-broken continuation state to clients.
  Make agent goal updates revisioned, attempt-recoverable commands so ambiguous
  commit responses reconcile without duplicate mutation or stale overwrites.
- 860de22: Persist actor-private pre-session drafts on the server, consume only the exact accepted revision after durable session initialization, return structured create errors, deduplicate create resources, derive checksums for SDK uploads, restore finalized attachments without browser-local byte authority, and preserve attachments added while an earlier send is in flight.
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
  - @opengeni/db@0.12.0
  - @opengeni/config@0.7.0
  - @opengeni/core@0.11.0
  - @opengeni/runtime@0.13.2
  - @opengeni/documents@0.2.30
  - @opengeni/events@0.3.21
  - @opengeni/github@0.3.12
  - @opengeni/storage@0.2.24

## 0.10.0

### Minor Changes

- 0ed0f01: Add per-member session pin preferences with isolated server persistence, bounded/reused stable
  pagination snapshots, snapshot-free pin polling, typed SDK and React reconciliation, and accessible
  list and header controls.

### Patch Changes

- Updated dependencies [744a93d]
- Updated dependencies [0ed0f01]
- Updated dependencies [b32938f]
  - @opengeni/config@0.6.10
  - @opengeni/contracts@0.18.1
  - @opengeni/db@0.11.0
  - @opengeni/core@0.10.1
  - @opengeni/documents@0.2.29
  - @opengeni/github@0.3.11
  - @opengeni/runtime@0.13.1
  - @opengeni/storage@0.2.23
  - @opengeni/events@0.3.20

## 0.9.0

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

- Updated dependencies [0d60720]
- Updated dependencies [bdd531c]
  - @opengeni/config@0.6.9
  - @opengeni/contracts@0.18.0
  - @opengeni/core@0.10.0
  - @opengeni/db@0.10.7
  - @opengeni/network@0.1.1
  - @opengeni/runtime@0.13.0
  - @opengeni/codex@0.2.7
  - @opengeni/documents@0.2.28
  - @opengeni/github@0.3.10
  - @opengeni/storage@0.2.22
  - @opengeni/events@0.3.19

## 0.8.7

### Patch Changes

- 524599e: Normalize model, provider, upstream deployment, credential source, billing,
  capability, health, and pricing identity; expose a secret-safe authenticated
  workspace catalog with separate fail-closed credential readiness for federated
  providers; and persist the accepted model/reasoning execution policy on new
  logical turns.
- Updated dependencies [524599e]
  - @opengeni/config@0.6.8
  - @opengeni/contracts@0.17.3
  - @opengeni/core@0.9.7
  - @opengeni/db@0.10.6
  - @opengeni/runtime@0.12.6
  - @opengeni/documents@0.2.27
  - @opengeni/github@0.3.9
  - @opengeni/storage@0.2.21
  - @opengeni/events@0.3.18

## 0.8.6

### Patch Changes

- 229902b: Add trustworthy per-subscription Codex quota/reset-credit overview and allocator OCC controls, plus an owning-human managed-cookie-only reset redemption flow with durable ambiguity-safe provider idempotency.
- Updated dependencies [229902b]
  - @opengeni/codex@0.2.6
  - @opengeni/db@0.10.5
  - @opengeni/core@0.9.6
  - @opengeni/config@0.6.7
  - @opengeni/runtime@0.12.5
  - @opengeni/documents@0.2.26
  - @opengeni/events@0.3.17
  - @opengeni/github@0.3.8
  - @opengeni/storage@0.2.20

## 0.8.5

### Patch Changes

- Updated dependencies [4966649]
- Updated dependencies [cb188f9]
  - @opengeni/contracts@0.17.2
  - @opengeni/db@0.10.4
  - @opengeni/config@0.6.6
  - @opengeni/runtime@0.12.4
  - @opengeni/core@0.9.5
  - @opengeni/documents@0.2.25
  - @opengeni/events@0.3.16
  - @opengeni/github@0.3.7
  - @opengeni/storage@0.2.19

## 0.8.4

### Patch Changes

- 2174006: Bound Modal display startup ownership, parse terminal state only from trusted provider metadata, poll yielded processes to completion, and prevent detached desktop processes from retaining startup locks.
- Updated dependencies [2174006]
- Updated dependencies [4e16410]
  - @opengeni/runtime@0.12.3
  - @opengeni/core@0.9.4

## 0.8.3

### Patch Changes

- Updated dependencies [495c62c]
  - @opengeni/db@0.10.3
  - @opengeni/core@0.9.3
  - @opengeni/documents@0.2.24
  - @opengeni/events@0.3.15

## 0.8.2

### Patch Changes

- ff23da5: Keep oversized event previews bounded while optionally linking them to integrity-addressed workspace-file evidence, and expose access-controlled metadata plus capped provider-native range retrieval through the API and SDK.
- Updated dependencies [ff23da5]
  - @opengeni/contracts@0.17.1
  - @opengeni/db@0.10.2
  - @opengeni/events@0.3.14
  - @opengeni/storage@0.2.18
  - @opengeni/config@0.6.5
  - @opengeni/core@0.9.2
  - @opengeni/documents@0.2.23
  - @opengeni/github@0.3.6
  - @opengeni/runtime@0.12.2

## 0.8.1

### Patch Changes

- Updated dependencies [eed3438]
  - @opengeni/db@0.10.1
  - @opengeni/core@0.9.1
  - @opengeni/documents@0.2.22
  - @opengeni/events@0.3.13

## 0.8.0

### Minor Changes

- d1dee7a: Let embedding hosts read and update an existing session MCP server's approval
  policy through the public API, SDK, and React session hook. Each claimed
  attempt freezes its policy under the session lock, so updates affect the next
  attempt without reinterpreting work already running; model MCP and
  Toolspace/Code Mode consume the same exact snapshot. Toolspace tokens and
  side-effect receipts bind every proxied call to the exact active attempt, so
  Pause, Steer, recovery, and late outputs preserve one authoritative owner.

### Patch Changes

- Updated dependencies [d1dee7a]
  - @opengeni/contracts@0.17.0
  - @opengeni/config@0.6.4
  - @opengeni/core@0.9.0
  - @opengeni/db@0.10.0
  - @opengeni/documents@0.2.21
  - @opengeni/events@0.3.12
  - @opengeni/github@0.3.5
  - @opengeni/runtime@0.12.1
  - @opengeni/storage@0.2.17

## 0.7.4

### Patch Changes

- Updated dependencies [b9cec61]
- Updated dependencies [c978676]
  - @opengeni/contracts@0.16.0
  - @opengeni/runtime@0.12.0
  - @opengeni/config@0.6.3
  - @opengeni/core@0.8.1
  - @opengeni/db@0.9.4
  - @opengeni/documents@0.2.20
  - @opengeni/events@0.3.11
  - @opengeni/github@0.3.4
  - @opengeni/storage@0.2.16

## 0.7.3

### Patch Changes

- Updated dependencies [9f84cc9]
  - @opengeni/contracts@0.15.0
  - @opengeni/core@0.8.0
  - @opengeni/db@0.9.3
  - @opengeni/runtime@0.11.0
  - @opengeni/config@0.6.2
  - @opengeni/documents@0.2.19
  - @opengeni/events@0.3.10
  - @opengeni/github@0.3.3
  - @opengeni/storage@0.2.15

## 0.7.2

### Patch Changes

- Updated dependencies [136227e]
- Updated dependencies [3aee519]
  - @opengeni/contracts@0.14.0
  - @opengeni/core@0.7.0
  - @opengeni/runtime@0.10.0
  - @opengeni/config@0.6.1
  - @opengeni/db@0.9.2
  - @opengeni/documents@0.2.18
  - @opengeni/events@0.3.9
  - @opengeni/github@0.3.2
  - @opengeni/storage@0.2.14

## 0.7.1

### Patch Changes

- 1f0ed18: Restore immutable concurrent-index migration history, stage populated-table migrations safely, and reject goal-bearing child sessions whose resulting first-party authority lacks `goals:manage`.
- Updated dependencies [1f0ed18]
- Updated dependencies [00e1cdc]
  - @opengeni/core@0.6.1
  - @opengeni/db@0.9.1
  - @opengeni/documents@0.2.17
  - @opengeni/events@0.3.8

## 0.7.0

### Minor Changes

- 1f9305b: Add a host-owned session authorization port for embedded deployments. The port
  receives server-resolved root lineage and live agent-attempt authority, scopes
  session listing inside database queries, distinguishes exact from whole-tree
  projection access, gates HTTP/core/first-party MCP/Toolspace surfaces, and
  periodically reauthorizes idle SSE streams while standalone deployments retain
  their existing behavior when the port is unset.
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
- e8ca4f6: Let trusted embedding hosts sign a service-only causal initiator separately
  from the delegated subject that authorizes a create, Send, or Steer command.
  Freeze that service and its non-secret provenance onto the new session/turn,
  while rejecting human impersonation, exact agent-attempt replacement, reserved
  lineage fields, the legacy migration sentinel, and oversized provenance.
  Service-provenance HTTP tokens use a prefix-bound `ogd2_` envelope so older
  rolling-deploy verifiers fail closed instead of silently stripping attribution.
- 736f4fe: Persist and expose one immutable subject-or-service initiator for every accepted turn, including creator-safe idempotent repair, queue-edit preservation, exact live-attempt fencing for agent-created sessions, signed agent inheritance, causally dominant Agent Steer attribution, explicit service producers, rolling legacy backfill, and database-enforced immutability.
  Bounded agent provenance now retains its first causal hop together with the
  newest hops, so deep child chains do not discard their root authority when the
  middle of the audit path is truncated.

### Patch Changes

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
- 8c66185: Let agent-created child sessions inherit omitted repository, MCP tool, and
  per-session MCP server context from their trusted immediate parent. Explicit
  arrays remain authoritative, mixed Git providers and multiple bindings are
  preserved, and credential headers are copied only as encrypted ciphertext.
- 3ce795b: Route Toolspace token seeding, renewal, agent commands, and Channel-A terminal
  commands through deterministic per-session files when several sessions share a
  sandbox group. Preserve the box manifest's stable legacy pointer for warm-box
  compatibility, remove any legacy bearer during seeding, and prevent the
  group-global ttyd process from inheriting session-bound Toolspace authority.
- d249403: Allow embedding hosts to preallocate a session UUID before OpenGeni admits the
  initial turn. Session creation preserves idempotent replays of the same UUID and
  returns a conflict for UUID reuse or an idempotency replay that changes identity.
  The additive create response also returns `initialTurnId`, so an embedding host
  can correlate a preallocated host run without misusing the nullable
  `activeTurnId` execution pointer.
- 0c4796d: Bound opt-in `sessions_list` latest-message previews by a deterministic aggregate UTF-8 budget.
  Rows that exceed the budget remain discoverable with explicit omission metadata and a
  `session_events` drill-down route, while the existing response envelope and pagination cap remain
  independent.
- 5529945: Support Temporal Cloud and secured external Temporal endpoints across every API
  and worker connection. API-key authentication enables TLS automatically, while
  optional server-auth TLS, SNI override, custom root CA, and paired mTLS
  certificate settings share one validated connection policy.
- Updated dependencies [3a2258b]
- Updated dependencies [1fcd83d]
- Updated dependencies [32011f1]
- Updated dependencies [3983021]
- Updated dependencies [4401ce7]
- Updated dependencies [c389adc]
- Updated dependencies [1f9305b]
- Updated dependencies [8c66185]
- Updated dependencies [3ce795b]
- Updated dependencies [334b63f]
- Updated dependencies [d249403]
- Updated dependencies [a11a7fc]
- Updated dependencies [94f2580]
- Updated dependencies [b9d6e58]
- Updated dependencies [44ff327]
- Updated dependencies [dda6398]
- Updated dependencies [5529945]
- Updated dependencies [e8ca4f6]
- Updated dependencies [736f4fe]
  - @opengeni/core@0.6.0
  - @opengeni/contracts@0.13.0
  - @opengeni/runtime@0.9.0
  - @opengeni/config@0.6.0
  - @opengeni/db@0.9.0
  - @opengeni/documents@0.2.16
  - @opengeni/events@0.3.7
  - @opengeni/github@0.3.1
  - @opengeni/storage@0.2.13

## 0.6.0

### Minor Changes

- dbb6232: Support linking an existing GitHub App installation to multiple OpenGeni workspaces with independent repository allowlists.

  - Discover installations through GitHub App user OAuth, require repository-level administrator permission, and configure the OAuth callback in generated App manifests.
  - Persist workspace-scoped installation bindings and repository selections while retaining legacy `all` bindings for compatibility.
  - Enforce the current binding during repository listing, session admission, MCP token minting, and GitHub-authenticated worker turn startup.
  - Add SDK and web controls to link, rescope, and unlink a workspace without uninstalling the GitHub App or affecting another workspace.

### Patch Changes

- Bound model-facing tool output, complete input accounting, compact session discovery,
  event and realtime projections, authorized evidence retrieval, and compaction failure
  convergence with explicit truncation and loss metadata throughout the output lifecycle.
  Session event `latest` lookups are now class-exclusive across REST, MCP, and SDK clients.
  Updated-order session discovery now uses a transactional workspace activity-revision fence,
  and the workspace-control bounds migration rewrites only historical cap violations.
- Updated dependencies [77d65f9]
- Updated dependencies
- Updated dependencies [dbb6232]
- Updated dependencies [3e65c23]
  - @opengeni/db@0.8.0
  - @opengeni/core@0.5.0
  - @opengeni/codex@0.2.5
  - @opengeni/config@0.5.3
  - @opengeni/contracts@0.12.0
  - @opengeni/events@0.3.6
  - @opengeni/runtime@0.8.2
  - @opengeni/github@0.3.0
  - @opengeni/documents@0.2.15
  - @opengeni/storage@0.2.12

## 0.5.9

### Patch Changes

- Updated dependencies [28290a0]
- Updated dependencies [9a7dec2]
  - @opengeni/db@0.7.5
  - @opengeni/runtime@0.8.1
  - @opengeni/core@0.4.12
  - @opengeni/documents@0.2.14
  - @opengeni/events@0.3.5

## 0.5.8

### Patch Changes

- 14ce2e3: Bound model-facing textual tool output with Codex-compatible, replay-idempotent semantics, account
  for complete current model input, make compaction failure/progress transitions
  durable and convergent, and replace recursive session discovery with a compact
  paginated projection.
- Updated dependencies [14ce2e3]
- Updated dependencies [053c5df]
- Updated dependencies [ec0697a]
  - @opengeni/codex@0.2.4
  - @opengeni/config@0.5.2
  - @opengeni/db@0.7.4
  - @opengeni/runtime@0.8.0
  - @opengeni/contracts@0.11.0
  - @opengeni/core@0.4.11
  - @opengeni/documents@0.2.13
  - @opengeni/github@0.2.11
  - @opengeni/storage@0.2.11
  - @opengeni/events@0.3.4

## 0.5.7

### Patch Changes

- Updated dependencies [b9dbb63]
  - @opengeni/db@0.7.3
  - @opengeni/core@0.4.10
  - @opengeni/documents@0.2.12
  - @opengeni/events@0.3.3

## 0.5.6

### Patch Changes

- Updated dependencies [6882ff2]
  - @opengeni/codex@0.2.3
  - @opengeni/config@0.5.1
  - @opengeni/core@0.4.9
  - @opengeni/db@0.7.2
  - @opengeni/runtime@0.7.1
  - @opengeni/documents@0.2.11
  - @opengeni/github@0.2.10
  - @opengeni/storage@0.2.10
  - @opengeni/events@0.3.2

## 0.5.5

### Patch Changes

- Updated dependencies [ea52b39]
  - @opengeni/db@0.7.1
  - @opengeni/core@0.4.8
  - @opengeni/documents@0.2.10
  - @opengeni/events@0.3.1

## 0.5.4

### Patch Changes

- 0805620: Make active-sandbox pointer swaps establishment-safe. A swap or create-time seed to a target no turn can establish (a non-group Modal sibling, or an unknown backend kind) is now rejected before the epoch-fenced pointer commit with a typed rejection `code`, leaving the pointer and epoch untouched. At turn start a persisted pointer whose target is structurally unestablishable (a deleted sandbox row, a Modal sibling, or an enrollment-less selfhosted row) is reset to the session home under the epoch fence and announced with a new `session.route.reconciled` event, honoring a concurrent higher-epoch swap rather than clobbering it. A null pointer resolves to the session home backend, and the routing proxy's per-op cache is keyed on the full `(activeEpoch, activeSandboxId)` tuple so a clear-to-null re-lands the next op on home rather than a stale swapped-to session. Adds the optional `SwapActiveSandboxResponse.code` discriminant and the `session.route.reconciled` session event type to the public contracts and SDK wire types.
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

- b804fd4: Add provider-neutral git credential contracts and runtime sandbox token-file seeding for GitHub, GitLab, and Azure DevOps. Sandboxes now provision `gh`, `glab`, and `az` wrappers that read current token files at invocation time without storing token values in manifests.
- e4d3569: Add per-member workspace session pins with stable pinned-first listing, subject-scoped FORCE-RLS persistence, snapshot-backed activity pagination, optimistic OCC-safe pin/unpin updates, and accessible responsive web controls.
- 5942493: Repair missing file-upload usage records on idempotent finalize retries, reclaim abandoned direct-upload objects through a fenced Temporal cleanup schedule, and preserve accessible provider-backed image previews across reloads.
- a5f58f9: Make "stop" mean stop, and stop the child-completion flood from outrunning it.

  - **Stop drains the queue.** A non-steer interrupt now cancels the active turn AND all queued turns, emitting one `turn.queue_drained` summary event. Steer still promotes exactly one steered message.
  - **A user-paused goal is sacred.** A machine child-completion turn can no longer re-activate a goal the user paused (`goal_set` is refused for such callers), and the wake text drops the "resume it now" nudge when the manager's own goal is user-paused. The caller is classified by its own signed turn identity (a new `turnId` claim on the first-party MCP token), not the session's live active pointer — so the guard cannot be raced into refusing a legitimate human `goal_set`.
  - **Child-completion notifications coalesce.** N spawned workers reaching terminal states now fold into ONE queued digest turn (one model run) instead of N turns, so the flood can no longer outrun a human's stop button. Each worker still gets its own result card.
  - **Human messages preempt machine notifications.** A person's message jumps ahead of any queued child-completion notification turns (behind the running turn and earlier human turns) — it never waits behind a flood of "worker FAILED" notices.
  - **Child-completion suppression opt-in.** A new first-party `set_child_notifications_mode` tool lets a manager switch spawned-worker completions to `passive`: they appear as timeline cards only and never queue a turn or a model run. `digest` remains the default.
  - **Honest steering copy.** The composer no longer claims steer "injects this message now"; it cancels the current step and runs the message next while the goal continues, and the stop button says it clears queued messages and pauses the goal.

- Updated dependencies [332ac15]
- Updated dependencies [ad4502a]
- Updated dependencies [ec508d4]
- Updated dependencies [58c78c6]
- Updated dependencies [477b2bb]
- Updated dependencies [477b2bb]
- Updated dependencies [04d7595]
- Updated dependencies [0805620]
- Updated dependencies [1132866]
- Updated dependencies [faf1487]
- Updated dependencies [13d0889]
- Updated dependencies [832f84c]
- Updated dependencies [b125213]
- Updated dependencies [b804fd4]
- Updated dependencies [37ade2c]
- Updated dependencies [4a25bfc]
- Updated dependencies [4a25bfc]
- Updated dependencies [3148404]
- Updated dependencies [a0cb58f]
- Updated dependencies [3584f26]
- Updated dependencies [e4d3569]
- Updated dependencies [63f9113]
- Updated dependencies [f4a25d9]
- Updated dependencies [810542f]
- Updated dependencies [5942493]
- Updated dependencies [726cf2c]
- Updated dependencies [0f10413]
- Updated dependencies [3148404]
- Updated dependencies [1d57c33]
- Updated dependencies [a5f58f9]
- Updated dependencies [8fef500]
- Updated dependencies [27a114c]
- Updated dependencies [9d4283d]
  - @opengeni/core@0.4.7
  - @opengeni/db@0.7.0
  - @opengeni/config@0.5.0
  - @opengeni/runtime@0.7.0
  - @opengeni/codex@0.2.2
  - @opengeni/contracts@0.10.0
  - @opengeni/documents@0.2.9
  - @opengeni/events@0.3.0
  - @opengeni/github@0.2.9
  - @opengeni/storage@0.2.9
  - @opengeni/agent-proto@0.3.0

## 0.5.3

### Patch Changes

- ac924ca: Fix Modal private-registry sandbox image handling for embedded deployments and republish the observability API surface.

  Modal registry Secrets are resolved through the authenticated OpenGeni Modal client, and Modal private-registry images are now warmed at turn time for pack-scoped sandbox images, not only at worker boot for the deployment-global image ref.

  `@opengeni/observability` is minor-bumped so the already-source-shipped `setGauge`, `incrementCounter`, `observeHistogram`, and `debug` methods are available to external consumers. The published direct dependents are patch-bumped so their 0.x caret ranges resolve to the new observability minor in a coherent install.

- Updated dependencies [ac924ca]
  - @opengeni/observability@0.3.0
  - @opengeni/runtime@0.6.1
  - @opengeni/core@0.4.6

## 0.5.2

### Patch Changes

- Updated dependencies [1e7a243]
  - @opengeni/config@0.4.0
  - @opengeni/runtime@0.6.0
  - @opengeni/core@0.4.5
  - @opengeni/db@0.6.1
  - @opengeni/documents@0.2.8
  - @opengeni/github@0.2.8
  - @opengeni/storage@0.2.8
  - @opengeni/events@0.2.8

## 0.5.1

### Patch Changes

- b34b912: Toolspace: selfhosted parity + generic programmatic-calling agent instructions.

  Connected-machine (selfhosted) turns now receive the toolspace token like every other backend. The git-token skip does not transfer: the platform GitHub token is inert on a user machine, but the toolspace token is the machine's only path to programmatic tool calling. It is safe to deliver because it grants no more than the machine owner's own authority — `toolspace:call` only, bound to its own session, turn TTL, budgeted, approval-tools excluded. Delivery mirrors the docker path: the token is seeded to `$OPENGENI_TOOLSPACE_TOKEN_FILE` over the machine's exec channel, off-manifest, targeting the public sandbox-routable API URL; the platform setup hooks (repository clone, az login) still never run against the user's machine.

  When a toolspace token is minted for a turn (feature enabled, any backend), the agent's composed instructions carry a short, generic substrate note: every MCP tool is also callable programmatically from the sandbox via `ogtool` (or MCP JSON-RPC to `$OPENGENI_TOOLSPACE_URL` with the bearer from `$OPENGENI_TOOLSPACE_TOKEN_FILE`), prefer programmatic calls for loops/polling/bulk filtering because those results do not consume model context, and approval-required tools must still be invoked normally. The note composes after the workspace persona + CORE but before the per-session instructions. The `@opengeni/core` and `@opengeni/api-router` bumps are the dependent-closure patch for the runtime minor.

- Updated dependencies [b34b912]
  - @opengeni/runtime@0.5.0
  - @opengeni/core@0.4.4

## 0.5.0

### Minor Changes

- 602db89: Add Toolspace programmatic tool access for sandboxes.

  The new `toolspace:call` permission is an explicit, session-bound delegated grant for sandbox code. When `OPENGENI_TOOLSPACE_ENABLED=true`, worker turns mint a narrow `ogd_` token to a sandbox token file and expose `OPENGENI_TOOLSPACE_URL`; the first-party MCP route uses that token to compose the session's safe first-party, capability-backed, and per-session MCP tools, with approval-required tools denied as MCP `isError` results.

### Patch Changes

- Updated dependencies [602db89]
  - @opengeni/contracts@0.9.0
  - @opengeni/config@0.3.0
  - @opengeni/db@0.6.0
  - @opengeni/runtime@0.4.0
  - @opengeni/core@0.4.3
  - @opengeni/documents@0.2.7
  - @opengeni/events@0.2.7
  - @opengeni/github@0.2.7
  - @opengeni/storage@0.2.7

## 0.4.2

### Patch Changes

- Updated dependencies [7bfe593]
- Updated dependencies [550b055]
- Updated dependencies [db468cc]
  - @opengeni/contracts@0.8.0
  - @opengeni/db@0.5.0
  - @opengeni/events@0.2.6
  - @opengeni/config@0.2.6
  - @opengeni/core@0.4.2
  - @opengeni/documents@0.2.6
  - @opengeni/github@0.2.6
  - @opengeni/runtime@0.3.2
  - @opengeni/storage@0.2.6

## 0.4.1

### Patch Changes

- Updated dependencies [5ca067f]
  - @opengeni/contracts@0.7.0
  - @opengeni/config@0.2.5
  - @opengeni/core@0.4.1
  - @opengeni/db@0.4.1
  - @opengeni/documents@0.2.5
  - @opengeni/events@0.2.5
  - @opengeni/github@0.2.5
  - @opengeni/runtime@0.3.1
  - @opengeni/storage@0.2.5

## 0.4.0

### Minor Changes

- e513236: Add an optional per-session `instructions` field to `CreateSessionRequest`: a first-class, system-level agent persona lever composed AFTER the per-workspace `agentInstructions` (session-specific last, non-bypassable CORE preserved). It is org-visible session metadata (returned on the session record) but is never emitted as a timeline event, so hosts can deliver per-agent-type prompts without leaking prompt content into the user-visible timeline or weakening instruction authority. Absent ⇒ byte-identical to today's composition.

### Patch Changes

- Updated dependencies [dbe3a19]
- Updated dependencies [3c223ca]
- Updated dependencies [e513236]
  - @opengeni/config@0.2.4
  - @opengeni/runtime@0.3.0
  - @opengeni/contracts@0.6.0
  - @opengeni/db@0.4.0
  - @opengeni/core@0.4.0
  - @opengeni/documents@0.2.4
  - @opengeni/github@0.2.4
  - @opengeni/storage@0.2.4
  - @opengeni/events@0.2.4

## 0.3.0

### Minor Changes

- 15deca0: Add per-session third-party MCP servers with write-only encrypted headers, metadata-only responses/events, `mcp_servers:attach` permission gating, and per-message credential rotation.

### Patch Changes

- Updated dependencies [15deca0]
  - @opengeni/contracts@0.5.0
  - @opengeni/db@0.3.0
  - @opengeni/core@0.3.0
  - @opengeni/config@0.2.3
  - @opengeni/documents@0.2.3
  - @opengeni/events@0.2.3
  - @opengeni/github@0.2.3
  - @opengeni/runtime@0.2.3
  - @opengeni/storage@0.2.3

## 0.2.2

### Patch Changes

- 5962dd0: Republish the closure so published manifests reference `@opengeni/contracts@^0.4.0`. The previous `^0.3.0` ranges exclude 0.4.0 under 0.x caret semantics, causing consumers to nest a stale contracts copy that lacks the current export surface.
- Updated dependencies [5962dd0]
  - @opengeni/agent-proto@0.2.1
  - @opengeni/codex@0.2.1
  - @opengeni/config@0.2.2
  - @opengeni/core@0.2.2
  - @opengeni/db@0.2.2
  - @opengeni/documents@0.2.2
  - @opengeni/events@0.2.2
  - @opengeni/github@0.2.2
  - @opengeni/observability@0.2.1
  - @opengeni/runtime@0.2.2
  - @opengeni/storage@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies [548e307]
  - @opengeni/contracts@0.4.0
  - @opengeni/config@0.2.1
  - @opengeni/core@0.2.1
  - @opengeni/db@0.2.1
  - @opengeni/documents@0.2.1
  - @opengeni/events@0.2.1
  - @opengeni/github@0.2.1
  - @opengeni/runtime@0.2.1
  - @opengeni/storage@0.2.1

## 0.2.0

### Minor Changes

- 2170732: Publish the full Stage C `@opengeni/*` runtime closure to npm so external hosts can consume OpenGeni from published packages instead of vendored workspace tarballs.

  The release pipeline now builds every publishable package, rewrites every published `workspace:*` dependency to a concrete semver range, rewrites source entry points to dist entry points for every publishable package, and leaves only leaf-only non-runtime packages ignored.

### Patch Changes

- Updated dependencies [2170732]
  - @opengeni/agent-proto@0.2.0
  - @opengeni/codex@0.2.0
  - @opengeni/config@0.2.0
  - @opengeni/core@0.2.0
  - @opengeni/db@0.2.0
  - @opengeni/documents@0.2.0
  - @opengeni/events@0.2.0
  - @opengeni/github@0.2.0
  - @opengeni/observability@0.2.0
  - @opengeni/runtime@0.2.0
  - @opengeni/storage@0.2.0
