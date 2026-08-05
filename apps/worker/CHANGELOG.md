# @opengeni/worker-bundle

## 0.16.23

### Patch Changes

- 7dbd057: Preserve provider-defined repository clone paths and centralize provider-declared `.git` alias semantics across resource identity and credential routing.
- 30a0b9a: Preserve internal content exactly, replace heuristic rewriting with lossless persistence, and keep public telemetry on reviewed structural projections.
- 1503151: Keep capped rotation-off Codex sessions in one durable capacity wait and suppress wakes for identical usage snapshots.
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

## 0.16.22

### Patch Changes

- 5d1d0c2: Make browser live streams visibility-aware, share one routed session feed,
  bound reconciliation and heartbeat recovery, coalesce overlapping reads, and
  expose the append, publish, and SSE connection lifecycle in metrics.
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

## 0.16.21

### Patch Changes

- Updated dependencies [33166b0]
  - @opengeni/observability@0.5.0
  - @opengeni/core@0.21.2

## 0.16.20

### Patch Changes

- 55f6ad0: Use one terminal-response ordinal for provider context binding, and clear the
  durable input-token signal when the latest provider response supplies no usable
  usage instead of retaining an older response's count.
- Updated dependencies [55f6ad0]
- Updated dependencies [18eea76]
  - @opengeni/db@0.28.1
  - @opengeni/runtime@0.18.17
  - @opengeni/core@0.21.1
  - @opengeni/documents@0.5.10
  - @opengeni/events@0.3.80

## 0.16.19

### Patch Changes

- 6eb0b23: Add production resumable composer transcription with exact-subject durable
  manifests, idempotent SHA-256 chunk uploads, bounded ffmpeg segmentation, one
  recording-wide provider pin, persisted retryable segment results, deterministic
  assembly, cross-browser SDK recovery, object-ledger cleanup, and expiry purging
  of transcript metadata after every provider object is confirmed deleted. Legacy
  one-shot voice input remains compatible.
- 5b6d36e: Use provider-reported usage rather than whole-request approximations for automatic context compaction, preserve provider-only input-token state across context rewrites, and label timeline counts as estimated conversation-history tokens.
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

## 0.16.18

### Patch Changes

- Updated dependencies [cbf165a]
  - @opengeni/db@0.27.12
  - @opengeni/core@0.20.17
  - @opengeni/documents@0.5.8
  - @opengeni/events@0.3.78

## 0.16.17

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

## 0.16.16

### Patch Changes

- c6c9acb: Recover required MCP setup when a transient socket failure is wrapped by the MCP SDK, while preserving only secret-safe transport classification.
- Updated dependencies [c6c9acb]
  - @opengeni/runtime@0.18.14
  - @opengeni/core@0.20.15

## 0.16.15

### Patch Changes

- 69bc207: Keep Codex history canonical across subscriptions and providers, separate optional owner-designated Codex Apps authority from inference allocation, and fence Apps authorization through each remote request.
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

## 0.16.14

### Patch Changes

- Updated dependencies [8105c25]
  - @opengeni/runtime@0.18.12
  - @opengeni/core@0.20.13

## 0.16.13

### Patch Changes

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

## 0.16.12

### Patch Changes

- dfa3aef: Preserve Steer priority through provider recovery and repair interrupted attempts durably.
- Updated dependencies [dfa3aef]
  - @opengeni/core@0.20.11
  - @opengeni/db@0.27.8
  - @opengeni/documents@0.5.4
  - @opengeni/events@0.3.74

## 0.16.11

### Patch Changes

- Updated dependencies [c29fd4c]
  - @opengeni/core@0.20.10
  - @opengeni/db@0.27.7
  - @opengeni/documents@0.5.3
  - @opengeni/events@0.3.73

## 0.16.10

### Patch Changes

- Updated dependencies [664c1d8]
  - @opengeni/core@0.20.9
  - @opengeni/db@0.27.6
  - @opengeni/runtime@0.18.10
  - @opengeni/documents@0.5.2
  - @opengeni/events@0.3.72

## 0.16.9

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

## 0.16.8

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

## 0.16.7

### Patch Changes

- Updated dependencies [d5df927]
- Updated dependencies [4976e1c]
  - @opengeni/documents@0.4.1
  - @opengeni/core@0.20.6
  - @opengeni/db@0.27.3
  - @opengeni/runtime@0.18.7
  - @opengeni/events@0.3.69

## 0.16.6

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

## 0.16.5

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

## 0.16.4

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

## 0.16.3

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

## 0.16.2

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

## 0.16.1

### Patch Changes

- d1f0c3d: Add immutable organization, workspace, and initiating-user personal authority to Documents and chunks; filter retrieval by exact account and authority before ranking; require exact account-admin authority for organization publication; and preserve authority through a drained API, worker, and indexing-workflow cutover.
- 088d7cb: Replay historical three-field document indexing workflows by resolving the immutable stored authority tuple under exact account and workspace RLS before parser, embedding, status, or chunk writes.
- 74bd3a5: Project image content and image-only tools from the model capability catalogue without mutating durable session history.
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

## 0.16.0

### Minor Changes

- e03397d: Freeze workspace instruction policies and structured preference descriptors at
  the accepted logical-turn boundary, add immutable per-session policy roles, and
  compose the resulting exact-attempt governance into agent and compaction prompts.

### Patch Changes

- 4f15920: Add an authorized, server-mediated connected-Codex GPT-Live V3 WebRTC SDP path with credential-safe negotiation and browser lifecycle helpers.
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

## 0.15.2

### Patch Changes

- b4982fa: Pin DeepSeek V4 Flash and Kimi K3 to ordered, approved Vercel AI Gateway
  provider routes, meter managed usage from Gateway-reported cost, and preserve
  Kimi Responses tool continuity without exposing provider details in the UI.
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

## 0.15.1

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

## 0.15.0

### Minor Changes

- 8b3e46f: Allow a digest-pinned capability-pack sandbox image to bind an immutable Modal image ID. OpenGeni now preserves the logical OCI digest on the lease, starts the provider-native image through `ModalImageSelector.fromId`, records the actual ID in the Modal session envelope, clears lower-precedence IDs when a rig overrides the image, and keeps catalog image metadata aligned with the runtime manifest.

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

## 0.14.3

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

## 0.14.2

### Patch Changes

- Updated dependencies [6500589]
  - @opengeni/documents@0.2.67
  - @opengeni/core@0.17.2

## 0.14.1

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

## 0.14.0

### Minor Changes

- dd71248: Make workspace-owned MCP OAuth connections the default, add explicit personal
  connection ownership, and preserve exact delegated personal authority across
  turns, child sessions, goals, schedules, retries, and recovery with safe
  tool-level degradation when a personal connection is unavailable.

### Patch Changes

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

## 0.13.11

### Patch Changes

- Updated dependencies [38ba6bc]
  - @opengeni/observability@0.4.0
  - @opengeni/runtime@0.16.0
  - @opengeni/core@0.16.3

## 0.13.10

### Patch Changes

- 0206eb6: Pass pack- and rig-resolved sandbox image settings into eager and lazy provider creation.
- Updated dependencies [1a2d41f]
  - @opengeni/db@0.19.0
  - @opengeni/core@0.16.2
  - @opengeni/documents@0.2.64
  - @opengeni/events@0.3.55

## 0.13.9

### Patch Changes

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

## 0.13.8

### Patch Changes

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

## 0.13.7

### Patch Changes

- Updated dependencies [8243ffe]
  - @opengeni/config@0.8.1
  - @opengeni/core@0.15.1
  - @opengeni/db@0.17.1
  - @opengeni/documents@0.2.61
  - @opengeni/github@0.4.11
  - @opengeni/runtime@0.15.1
  - @opengeni/storage@0.2.48
  - @opengeni/events@0.3.52

## 0.13.6

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

## 0.13.5

### Patch Changes

- Updated dependencies [cb4d78d]
  - @opengeni/runtime@0.14.16
  - @opengeni/core@0.14.4

## 0.13.4

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

## 0.13.3

### Patch Changes

- Updated dependencies [11cdf20]
  - @opengeni/runtime@0.14.14
  - @opengeni/core@0.14.2

## 0.13.2

### Patch Changes

- 472b4d1: Reopen turn-end workspace capture through an exact-instance, non-owning sandbox read handle and allow a production-realistic capture deadline.

## 0.13.1

### Patch Changes

- 02fb98c: Reconcile expired draining sandboxes after their exact provider instance has disappeared.
- Updated dependencies [02fb98c]
  - @opengeni/db@0.16.1
  - @opengeni/core@0.14.1
  - @opengeni/documents@0.2.58
  - @opengeni/events@0.3.49

## 0.13.0

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

## 0.12.21

### Patch Changes

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

## 0.12.20

### Patch Changes

- 710b081: Keep sessions usable when a previously selected MCP capability is disconnected or removed. Unavailable historical refs remain visible in effective policy but are omitted from executable tools, and the agent receives a bounded turn-level warning not to claim access to the missing source.
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
  - @opengeni/core@0.13.9
  - @opengeni/contracts@0.24.3
  - @opengeni/config@0.7.19
  - @opengeni/db@0.15.5
  - @opengeni/runtime@0.14.11
  - @opengeni/documents@0.2.55
  - @opengeni/events@0.3.46
  - @opengeni/github@0.4.6
  - @opengeni/storage@0.2.43

## 0.12.19

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

## 0.12.18

### Patch Changes

- 510eae3: Keep restored Modal checkpoints valid across live workspace writes, serialize
  lease reaping with concurrent acquisition, and rotate image or rig changes
  through durable checkpoint capture instead of discarding provider ownership.
- Updated dependencies [510eae3]
  - @opengeni/db@0.15.3
  - @opengeni/core@0.13.7
  - @opengeni/documents@0.2.53
  - @opengeni/events@0.3.44

## 0.12.17

### Patch Changes

- 3450ee5: Estimate typed images as bounded native media only after validating PNG IHDR CRCs, preserve exact model-history prefixes across requests, and fail closed for computer use whenever hosted or structured-image transport is omitted or unproven so screenshots cannot become base64 function text.
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

## 0.12.16

### Patch Changes

- 6d167f4: Recover exact Codex encrypted-artifact rejections without deleting durable conversation truth, and make maintenance migration protocol activation part of the canonical migration transaction.
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

## 0.12.15

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

## 0.12.14

### Patch Changes

- 821f664: Seed shared session-event cursors from loaded history to prevent historical replay storms, and preserve the MCP SDK's exact request-timeout classification through safe transport-error sanitization.
- Updated dependencies [848287f]
- Updated dependencies [2a7900f]
- Updated dependencies [821f664]
  - @opengeni/db@0.14.7
  - @opengeni/runtime@0.14.6
  - @opengeni/core@0.13.3
  - @opengeni/documents@0.2.49
  - @opengeni/events@0.3.40

## 0.12.13

### Patch Changes

- Updated dependencies [2aca964]
  - @opengeni/db@0.14.6
  - @opengeni/core@0.13.2
  - @opengeni/documents@0.2.48
  - @opengeni/events@0.3.39

## 0.12.12

### Patch Changes

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

## 0.12.11

### Patch Changes

- 1973d2a: Treat provider-native web search as an always-on runtime capability whenever
  the selected provider supports it. Session MCP selection no longer disables
  native search.
- 8478e60: Default workspace-tracking sessions to every configured MCP server while
  preserving exact explicit API allow-lists. Keep OpenGeni's internal carrier and
  default-on Files surface out of the web picker's visible choices and counts.
  Settle provider-native web searches from their own terminal status, render each
  web action truthfully, keep completed searches before the answer they informed,
  and hide unresolved private citation handles from the human timeline.
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

## 0.12.10

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

## 0.12.9

### Patch Changes

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

## 0.12.8

### Patch Changes

- Updated dependencies [6908a7a]
  - @opengeni/db@0.14.1
  - @opengeni/core@0.12.8
  - @opengeni/documents@0.2.43
  - @opengeni/events@0.3.34

## 0.12.7

### Patch Changes

- f2eebc8: Route Codex Apps through the durable per-session MCP tool policy so exact
  allowlists cannot be widened by a runtime credential overlay.
- Updated dependencies [f2eebc8]
  - @opengeni/core@0.12.7

## 0.12.6

### Patch Changes

- b2e23f3: Resolve Connected Machine Toolspace token files against the machine user's real
  home directory instead of the selfhosted capability root.
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

- f92af07: Remove Bun-global dependencies from the worker turn path and Docker network attachment so embedded workers run identically in Node and Bun.
- Updated dependencies [f92af07]
  - @opengeni/runtime@0.13.13
  - @opengeni/core@0.12.2

## 0.12.1

### Patch Changes

- ffd246c: Keep workspace-capture Git status, diffs, and untracked files below provider retained-output limits, and publish an explicit degraded revision instead of an authoritative empty diff when repository reads fail.
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

- 5511c24: Add a secure workspace-shared OpenGeni Slack bot connection with schema-backed verified-install eligibility, immutable team/bot identity across reinstall, idempotent post-operation convergence, exact scope validation, first-party channel/history/user/post tools, explicit scheduled-task routing and rebinding, and install/reinstall/recovery UI and documentation.

### Patch Changes

- 9326255: Let a single-machine turn worker adapt activity concurrency to whole-system CPU
  and memory targets while preserving fixed per-worker concurrency elsewhere.
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

- 85cb323: Restore provider-native web search for workspace-default Codex sessions while preserving explicit
  tool narrowing, child policy ceilings, version-fenced policy adoption, and structured URL citations.
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

- bc6c535: Retry transient sandbox archive restore failures through both lazy provisioning and concurrent warmup waiters.
- 1386679: Make context compaction provider-portable with Codex-compatible plaintext checkpoints, drop
  foreign account-bound reasoning during subscription rotation, and preserve the exact logical turn
  through durable all-subscriptions-exhausted capacity waits.
- de20184: Redact known runtime credentials and recognized authorization, cookie, signed
  URL, assignment, and provider-token shapes before model calls, durable session
  history, events, logs, and telemetry. Disable credential-bearing shell xtrace
  and raw Agents SDK model, tool, and MCP transport payload logging.
- 41f37ee: Classify the platform's generic pre-model upstream connectivity failure as a typed, retryable same-turn recovery instead of terminating fresh no-rig sessions.
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

- 7c6aa7c: Keep Codex connected-app MCP tools disabled by default behind the independent
  `OPENGENI_CODEX_CONNECTED_APPS_ENABLED` deployment switch.
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
- 7736781: Project supported ready file attachments with verified size and canonical SHA-256 metadata into typed image and file content for Responses model turns while preserving the sandbox-path fallback and durable history invariants.
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

## 0.10.9

### Patch Changes

- 744a93d: Add default-off, bounded adaptive Codex fleet decision telemetry with strict deterministic replay, cache-aware and work-conserving policy simulation, secret-safe event/UI observability, and independent future policy gates.
- b32938f: Preserve the resolved model tool-output policy across pending-call recovery so
  ordinary and recovered conversation history use one byte-identical bound.
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

## 0.10.8

### Patch Changes

- 0d60720: Add capability-first session tool policies with omission-as-discovery defaults,
  explicit per-turn narrowing and child inheritance, secret-safe effective-policy
  projections, stable lazy `tool_search` catalogs, and matching API, SDK, React,
  worker, embedding, and audit contracts.

  Harden credential-bearing MCP and OAuth traffic with destination-bound
  credentials, single-resolution DNS-pinned transport, bounded catalogs, schemas,
  results, request and response bodies, and independently validated manual
  redirects. Extend renewable, session-bound Toolspace access to connected
  machines while dynamically fencing every call to the session's active attempt.

- bdd531c: Make Codex subscription response timeouts recoverable without blindly replaying partially observed model work. The transport now assigns a durable request identity, records attempt-fenced start/headers/first-byte/terminal metadata, enforces explicit headers, stream-idle, and whole-request deadlines, and retries once only before any response is observed. Exhausted or partial-stream timeouts retain a typed failure class and return the durable session to its existing retryable recovery path instead of hard-failing it with the opaque OpenAI SDK `Request timed out.` error. External cancellation remains authoritative, the SDK retry budget remains disabled, and Codex subscription turns keep their existing zero-credit billing path.
- Updated dependencies [0d60720]
- Updated dependencies [bdd531c]
  - @opengeni/config@0.6.9
  - @opengeni/contracts@0.18.0
  - @opengeni/core@0.10.0
  - @opengeni/db@0.10.7
  - @opengeni/runtime@0.13.0
  - @opengeni/codex@0.2.7
  - @opengeni/documents@0.2.28
  - @opengeni/github@0.3.10
  - @opengeni/storage@0.2.22
  - @opengeni/events@0.3.19

## 0.10.7

### Patch Changes

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

## 0.10.6

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

## 0.10.5

### Patch Changes

- cb188f9: Protect clean rig verification sandboxes with canonical exact-instance leases, make Modal orphan termination revalidate durable ownership immediately before deletion, and add a default-off two-phase rollout flag.
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

## 0.10.4

### Patch Changes

- 4e16410: Preserve provider-reported prompt-cache writes through source-key-authoritative production usage paths, deduplicate mirrored and retried terminal responses before response-scoped side effects, derive billing and context totals from canonical input/output and complete SDK request aggregates, distinguish unknown cache reads from real zeros with call-traffic-aware availability alerting, and reject inconsistent or unsafe token values before billing or metrics.
- Updated dependencies [2174006]
- Updated dependencies [4e16410]
  - @opengeni/runtime@0.12.3
  - @opengeni/core@0.9.4

## 0.10.3

### Patch Changes

- Updated dependencies [495c62c]
  - @opengeni/db@0.10.3
  - @opengeni/core@0.9.3
  - @opengeni/documents@0.2.24
  - @opengeni/events@0.3.15

## 0.10.2

### Patch Changes

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

## 0.10.1

### Patch Changes

- Updated dependencies [eed3438]
  - @opengeni/db@0.10.1
  - @opengeni/core@0.9.1
  - @opengeni/documents@0.2.22
  - @opengeni/events@0.3.13

## 0.10.0

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

## 0.9.0

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
  - @opengeni/runtime@0.12.0
  - @opengeni/config@0.6.3
  - @opengeni/core@0.8.1
  - @opengeni/db@0.9.4
  - @opengeni/documents@0.2.20
  - @opengeni/events@0.3.11
  - @opengeni/github@0.3.4
  - @opengeni/storage@0.2.16

## 0.8.3

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

## 0.8.2

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

## 0.8.1

### Patch Changes

- Updated dependencies [1f0ed18]
- Updated dependencies [00e1cdc]
  - @opengeni/core@0.6.1
  - @opengeni/db@0.9.1
  - @opengeni/documents@0.2.17
  - @opengeni/events@0.3.8

## 0.8.0

### Minor Changes

- 32011f1: Add an optional durable host event and usage export for embedded deployments: source-transactional bounded snapshots, immutable turn attribution and session-root lineage, named at-least-once checkpoints, multi-replica leases, replay and retention controls, explicit poison-record disposition, an isolated exporter database role, and a worker delivery pump. Standalone deployments keep capture disabled until a host registers a sink.
- 7d9717a: Ship a release-coherent pre-bundled Temporal workflow artifact and expose a
  role-aware embedded worker lifecycle with health, readiness, metrics, internal
  schedule ownership, and graceful drain. Installed hosts no longer relocate raw
  workflow TypeScript out of `node_modules`.

  Existing lower-level `createOpenGeniWorker` callers should remove copied-source
  `workflowsPath` configuration. Installed control workers use the packaged
  artifact automatically; an explicitly version-bound artifact may be supplied as
  `workflowBundle`. Turn workers reject that control-only override.

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

- 3983021: Bind every host Git credential request to immutable session, root-session, turn,
  attempt, execution-generation, and initiator authority. The worker fails closed
  when a host broker is configured without that authority and preserves the same
  authority across identity resolution, lazy provisioning, and proactive renewal.
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
- ba78c88: Expose the durable host-export pump through a lightweight `@opengeni/worker-bundle/host-export` subpath so embedded API processes can project events and usage without loading Temporal's native worker runtime.
- d249403: Allow embedding hosts to preallocate a session UUID before OpenGeni admits the
  initial turn. Session creation preserves idempotent replays of the same UUID and
  returns a conflict for UUID reuse or an idempotency replay that changes identity.
  The additive create response also returns `initialTurnId`, so an embedding host
  can correlate a preallocated host run without misusing the nullable
  `activeTurnId` execution pointer.
- 94f2580: Keep sandbox Toolspace and Code Mode available during unbounded turns by
  proactively re-signing the session-bound delegated bearer and atomically
  replacing its off-manifest token file on managed and connected-machine backends.
- 5529945: Support Temporal Cloud and secured external Temporal endpoints across every API
  and worker connection. API-key authentication enables TLS automatically, while
  optional server-auth TLS, SNI override, custom root CA, and paired mTLS
  certificate settings share one validated connection policy.
- 4498714: Declare the externalized GitHub and agent-protocol packages required by the published worker bundle.
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

## 0.7.8

### Patch Changes

- 77d65f9: Use one canonical lock order for session-event persistence and retry only idempotent database transactions after deadlock or serialization failures, including generic event appends and operation-keyed Agent commands.
- Bound model-facing tool output, complete input accounting, compact session discovery,
  event and realtime projections, authorized evidence retrieval, and compaction failure
  convergence with explicit truncation and loss metadata throughout the output lifecycle.
  Session event `latest` lookups are now class-exclusive across REST, MCP, and SDK clients.
  Updated-order session discovery now uses a transactional workspace activity-revision fence,
  and the workspace-control bounds migration rewrites only historical cap violations.
- dbb6232: Support linking an existing GitHub App installation to multiple OpenGeni workspaces with independent repository allowlists.

  - Discover installations through GitHub App user OAuth, require repository-level administrator permission, and configure the OAuth callback in generated App manifests.
  - Persist workspace-scoped installation bindings and repository selections while retaining legacy `all` bindings for compatibility.
  - Enforce the current binding during repository listing, session admission, MCP token minting, and GitHub-authenticated worker turn startup.
  - Add SDK and web controls to link, rescope, and unlink a workspace without uninstalling the GitHub App or affecting another workspace.

- 3e65c23: Keep deterministic Codex subscription sharding sticky through 99% usage and
  rotate only after actual exhaustion or a definitive provider refusal. Remove the
  configurable near-exhaustion cutoff so warning presentation cannot strand usable
  subscription allowance.
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
  - @opengeni/documents@0.2.15
  - @opengeni/storage@0.2.12

## 0.7.7

### Patch Changes

- 28290a0: Make context compaction and pending tool-call recovery converge without reactivating superseded history or repeating failed internal turns.
- Updated dependencies [28290a0]
- Updated dependencies [9a7dec2]
  - @opengeni/db@0.7.5
  - @opengeni/runtime@0.8.1
  - @opengeni/core@0.4.12
  - @opengeni/documents@0.2.14
  - @opengeni/events@0.3.5

## 0.7.6

### Patch Changes

- 14ce2e3: Bound model-facing textual tool output with Codex-compatible, replay-idempotent semantics, account
  for complete current model input, make compaction failure/progress transitions
  durable and convergent, and replace recursive session discovery with a compact
  paginated projection.
- ec0697a: Ship the production-hardened captured workspace workbench, physically verified Steer/Pause cancellation across cloud, local, and self-hosted model tools, pre-model preparation, sandbox provisioning, and lifecycle/setup commands, durable quiescence admission fencing, cancellation-aware SDK reads and turn cleanup, single-round-trip pruned workspace indexing, truthful shutdown states, a responsive and accessible review dock, Unicode coverage, and package-safe CSS/SSR integration.
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
  - @opengeni/storage@0.2.11
  - @opengeni/events@0.3.4

## 0.7.5

### Patch Changes

- b9dbb63: Keep failed-child result provenance owned by the atomic turn settlement. Worker activities now read and deliver the exact committed outbox row without rewriting its turn-scoped payload or lineage.
- Updated dependencies [b9dbb63]
  - @opengeni/db@0.7.3
  - @opengeni/core@0.4.10
  - @opengeni/documents@0.2.12
  - @opengeni/events@0.3.3

## 0.7.4

### Patch Changes

- 6882ff2: Reuse the failed turn identity across database and workflow child-terminal producers so one failure cannot enqueue two parent updates. Bind the Codex subscription client header and compaction documentation to latest stable Codex CLI 0.144.5.
- Updated dependencies [6882ff2]
  - @opengeni/codex@0.2.3
  - @opengeni/config@0.5.1
  - @opengeni/core@0.4.9
  - @opengeni/db@0.7.2
  - @opengeni/runtime@0.7.1
  - @opengeni/documents@0.2.11
  - @opengeni/storage@0.2.10
  - @opengeni/events@0.3.2

## 0.7.3

### Patch Changes

- ea52b39: Recover retryable provider failures as new fenced attempts of the same accepted turn, independent of goal state, while preserving durable tool history and pause controls.
- Updated dependencies [ea52b39]
  - @opengeni/db@0.7.1
  - @opengeni/core@0.4.8
  - @opengeni/documents@0.2.10
  - @opengeni/events@0.3.1

## 0.7.2

### Patch Changes

- 477b2bb: Add a "sharded" codex rotation strategy: session-sharded account affinity. Each session is assigned a deterministic HOME account (`hash(sessionId) % healthy-accounts`) at its first codex turn, written as a `policy` pin (a new `sessions.codex_pin_source` discriminator distinguishes it from a user's `manual` pin). A session stays on its one home account for prompt-cache warmth while load spreads ~1/N across the pool.

  Both rotation guards (proactive turn-start and reactive 429) now allow a `policy`-pinned session to rebalance when its account caps — never a `manual` pin, which stays sacred. A rebalance durably REWRITES the session pin (re-sharding over the healthy survivors so capped-account cohorts spread instead of re-concentrating on one failover) rather than moving only the workspace active pointer, because credential selection returns a pinned account with no exhaustion check.

  Pin lifecycle: a `manual` pin is honored under every strategy; a `policy` pin is meaningful only while the sharded policy is active. When a workspace runs a non-sharded strategy (or rotation is disabled), a leftover policy pin is ignored and lazily cleared on the session's next turn — so the session converges to the active strategy instead of idling on a capped ex-home. The strategy is selectable alongside `most_remaining`/`round_robin`/`drain_then_next` via the existing rotation-settings API; unpinned behavior under the other strategies is unchanged.

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

- b125213: Proactively renew GitHub, GitLab, and Azure DevOps credentials during multi-day managed-sandbox turns, atomically replacing stable token files without model action or manifest mutation.
- b804fd4: Add provider-neutral git credential contracts and runtime sandbox token-file seeding for GitHub, GitLab, and Azure DevOps. Sandboxes now provision `gh`, `glab`, and `az` wrappers that read current token files at invocation time without storing token values in manifests.
- 39dae14: Make prompt-cache efficiency measurable per model call. The worker now reads `cached_tokens` from the same usage frame that feeds input-token accounting and emits two provider-labelled Prometheus series: `opengeni_model_cached_tokens_total{provider}` (cumulative prompt tokens served from the provider's cache) and `opengeni_model_cache_hit_ratio{provider}` (per-call cached/prompt ratio, bucketed around the alerting threshold). A provider that does not report cached tokens records a real 0 ratio rather than nothing — "the cache did nothing" is the signal — and never a phantom counter increment. Labels stay bounded (provider only; never a session id or account).

  Each per-call `model call usage` log line gains two log-only research dimensions: `servingAccountHash` (an opaque, non-reversible tag for the serving codex credential — the credential row id hashed, never a token) and `accountChangedFromPrevCall` (whether the serving account changed versus the session's previous call — the account-rotation-cold-starts-the-cache hypothesis). These are log-only and never leak into the durable `agent.model.usage` event, which already carries `cachedTokens`. The non-codex credit-debit ledger record additionally carries `cachedTokens` (additive).

  A new starter alert `OpenGeniCodexPromptCacheHitRatioLow` fires when the codex-subscription cache-hit ratio p50 falls below 40% over 30m while codex calls are flowing (traffic-gated with the `or vector(0)` empty-vector guard, promtool-validated).

- 5942493: Repair missing file-upload usage records on idempotent finalize retries, reclaim abandoned direct-upload objects through a fenced Temporal cleanup schedule, and preserve accessible provider-backed image previews across reloads.
- a5f58f9: Make "stop" mean stop, and stop the child-completion flood from outrunning it.

  - **Stop drains the queue.** A non-steer interrupt now cancels the active turn AND all queued turns, emitting one `turn.queue_drained` summary event. Steer still promotes exactly one steered message.
  - **A user-paused goal is sacred.** A machine child-completion turn can no longer re-activate a goal the user paused (`goal_set` is refused for such callers), and the wake text drops the "resume it now" nudge when the manager's own goal is user-paused. The caller is classified by its own signed turn identity (a new `turnId` claim on the first-party MCP token), not the session's live active pointer — so the guard cannot be raced into refusing a legitimate human `goal_set`.
  - **Child-completion notifications coalesce.** N spawned workers reaching terminal states now fold into ONE queued digest turn (one model run) instead of N turns, so the flood can no longer outrun a human's stop button. Each worker still gets its own result card.
  - **Human messages preempt machine notifications.** A person's message jumps ahead of any queued child-completion notification turns (behind the running turn and earlier human turns) — it never waits behind a flood of "worker FAILED" notices.
  - **Child-completion suppression opt-in.** A new first-party `set_child_notifications_mode` tool lets a manager switch spawned-worker completions to `passive`: they appear as timeline cards only and never queue a turn or a model run. `digest` remains the default.
  - **Honest steering copy.** The composer no longer claims steer "injects this message now"; it cancels the current step and runs the message next while the goal continues, and the stop button says it clears queued messages and pauses the goal.

- 8fef500: Instrument the token-streaming pipeline with SLIs so "streaming is sluggish" resolves to a number and its layer is attributable. New worker Prometheus series: `opengeni_stream_ttft_seconds{provider}` (time from a model (re)start to its first streamed content delta, re-armed after every non-content event so a post-tool response measures the model's restart, not our tool time), `opengeni_stream_inter_delta_gap_seconds{provider,class}` (gap between consecutive same-class deltas, reset across boundaries), `opengeni_stream_batch_flush_events` + `opengeni_stream_batch_flush_duration_seconds` (the runtime batcher's coalescing shape), `opengeni_session_event_append_seconds` (durable DB write path) and `opengeni_session_event_publish_seconds` (best-effort NATS delivery path) split so a p99 climb points at Postgres vs. NATS, plus `opengeni_model_input_tokens{provider}` and `opengeni_context_compactions_total{trigger}` (the context-pressure pair that makes "compaction never firing while contexts run hot" queryable). All labels are bounded — never a session id or raw user-supplied model string. `appendAndPublishEvents` gains an optional timing observer (no new dependency on the observability package) and `createRuntimeBatcher` an optional `onFlush` hook; both fire on success and failure.
- 4fbd8a1: Treat transient upstream model-provider failures as retryable so a goal-bearing session recovers automatically instead of going terminal. A provider 5xx (500/502/503/529), a generic "server had a bad minute" body, or a dropped/again-able network connection (ECONNRESET/ETIMEDOUT/EAI_AGAIN/…) now classifies `retryable` and routes into the existing idle + goal-continuation path (auto-continue after the backpressure delay for goal-bearing sessions; wait for the next user message otherwise). Previously only 429/rate-limit and MCP-timeout were retryable, so a generic provider 5xx fell through to a hard `session.failed` that required a manual nudge — during an upstream provider degradation window this needlessly hard-failed a fleet of live sessions. HTTP status is authoritative (every 5xx retryable, 4xx still hard-fails); the ChatGPT/Codex usage-cap 429 stays non-retryable since a retry would just re-hit the cap.
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
  - @opengeni/storage@0.2.9

## 0.7.1

### Patch Changes

- ac924ca: Fix Modal private-registry sandbox image handling for embedded deployments and republish the observability API surface.

  Modal registry Secrets are resolved through the authenticated OpenGeni Modal client, and Modal private-registry images are now warmed at turn time for pack-scoped sandbox images, not only at worker boot for the deployment-global image ref.

  `@opengeni/observability` is minor-bumped so the already-source-shipped `setGauge`, `incrementCounter`, `observeHistogram`, and `debug` methods are available to external consumers. The published direct dependents are patch-bumped so their 0.x caret ranges resolve to the new observability minor in a coherent install.

- Updated dependencies [ac924ca]
  - @opengeni/observability@0.3.0
  - @opengeni/runtime@0.6.1
  - @opengeni/core@0.4.6

## 0.7.0

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
  - @opengeni/runtime@0.6.0
  - @opengeni/core@0.4.5
  - @opengeni/db@0.6.1
  - @opengeni/documents@0.2.8
  - @opengeni/storage@0.2.8
  - @opengeni/events@0.2.8

## 0.6.0

### Minor Changes

- b34b912: Toolspace: selfhosted parity + generic programmatic-calling agent instructions.

  Connected-machine (selfhosted) turns now receive the toolspace token like every other backend. The git-token skip does not transfer: the platform GitHub token is inert on a user machine, but the toolspace token is the machine's only path to programmatic tool calling. It is safe to deliver because it grants no more than the machine owner's own authority — `toolspace:call` only, bound to its own session, turn TTL, budgeted, approval-tools excluded. Delivery mirrors the docker path: the token is seeded to `$OPENGENI_TOOLSPACE_TOKEN_FILE` over the machine's exec channel, off-manifest, targeting the public sandbox-routable API URL; the platform setup hooks (repository clone, az login) still never run against the user's machine.

  When a toolspace token is minted for a turn (feature enabled, any backend), the agent's composed instructions carry a short, generic substrate note: every MCP tool is also callable programmatically from the sandbox via `ogtool` (or MCP JSON-RPC to `$OPENGENI_TOOLSPACE_URL` with the bearer from `$OPENGENI_TOOLSPACE_TOKEN_FILE`), prefer programmatic calls for loops/polling/bulk filtering because those results do not consume model context, and approval-required tools must still be invoked normally. The note composes after the workspace persona + CORE but before the per-session instructions. The `@opengeni/core` and `@opengeni/api-router` bumps are the dependent-closure patch for the runtime minor.

### Patch Changes

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
  - @opengeni/documents@0.2.6
  - @opengeni/runtime@0.3.2
  - @opengeni/storage@0.2.6

## 0.4.1

### Patch Changes

- Updated dependencies [5ca067f]
  - @opengeni/contracts@0.7.0
  - @opengeni/config@0.2.5
  - @opengeni/db@0.4.1
  - @opengeni/documents@0.2.5
  - @opengeni/events@0.2.5
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
  - @opengeni/documents@0.2.4
  - @opengeni/storage@0.2.4
  - @opengeni/events@0.2.4

## 0.3.0

### Minor Changes

- 15deca0: Add per-session third-party MCP servers with write-only encrypted headers, metadata-only responses/events, `mcp_servers:attach` permission gating, and per-message credential rotation.

### Patch Changes

- Updated dependencies [15deca0]
  - @opengeni/contracts@0.5.0
  - @opengeni/db@0.3.0
  - @opengeni/config@0.2.3
  - @opengeni/documents@0.2.3
  - @opengeni/events@0.2.3
  - @opengeni/runtime@0.2.3
  - @opengeni/storage@0.2.3

## 0.2.3

### Patch Changes

- 711edc6: `createOpenGeniWorker` accepts an optional `workflowsPath` so embedded hosts can point Temporal's workflow bundler at a relocated copy of `workflows.ts` — the in-package default under `node_modules` is not transpiled by Temporal's webpack. Standalone behavior is unchanged when unset.

## 0.2.2

### Patch Changes

- 5962dd0: Republish the closure so published manifests reference `@opengeni/contracts@^0.4.0`. The previous `^0.3.0` ranges exclude 0.4.0 under 0.x caret semantics, causing consumers to nest a stale contracts copy that lacks the current export surface.
- Updated dependencies [5962dd0]
  - @opengeni/codex@0.2.1
  - @opengeni/config@0.2.2
  - @opengeni/db@0.2.2
  - @opengeni/documents@0.2.2
  - @opengeni/events@0.2.2
  - @opengeni/observability@0.2.1
  - @opengeni/runtime@0.2.2
  - @opengeni/storage@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies [548e307]
  - @opengeni/contracts@0.4.0
  - @opengeni/config@0.2.1
  - @opengeni/db@0.2.1
  - @opengeni/documents@0.2.1
  - @opengeni/events@0.2.1
  - @opengeni/runtime@0.2.1
  - @opengeni/storage@0.2.1

## 0.2.0

### Minor Changes

- 2170732: Publish the full Stage C `@opengeni/*` runtime closure to npm so external hosts can consume OpenGeni from published packages instead of vendored workspace tarballs.

  The release pipeline now builds every publishable package, rewrites every published `workspace:*` dependency to a concrete semver range, rewrites source entry points to dist entry points for every publishable package, and leaves only leaf-only non-runtime packages ignored.

### Patch Changes

- Updated dependencies [2170732]
  - @opengeni/codex@0.2.0
  - @opengeni/config@0.2.0
  - @opengeni/db@0.2.0
  - @opengeni/documents@0.2.0
  - @opengeni/events@0.2.0
  - @opengeni/observability@0.2.0
  - @opengeni/runtime@0.2.0
  - @opengeni/storage@0.2.0
