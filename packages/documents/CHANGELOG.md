# @opengeni/documents

## 0.5.13

### Patch Changes

- Updated dependencies [7a84e1b]
- Updated dependencies [5d8bb99]
- Updated dependencies [238fb7e]
- Updated dependencies [af24281]
  - @opengeni/db@0.28.4
  - @opengeni/contracts@0.39.3
  - @opengeni/config@0.11.3
  - @opengeni/storage@0.2.71

## 0.5.12

### Patch Changes

- Updated dependencies [7dbd057]
- Updated dependencies [30a0b9a]
- Updated dependencies [23de73b]
- Updated dependencies [1503151]
- Updated dependencies [a296081]
  - @opengeni/contracts@0.39.2
  - @opengeni/db@0.28.3
  - @opengeni/config@0.11.2
  - @opengeni/storage@0.2.70

## 0.5.11

### Patch Changes

- Updated dependencies [110d255]
- Updated dependencies [ce823ce]
  - @opengeni/db@0.28.2
  - @opengeni/contracts@0.39.1
  - @opengeni/config@0.11.1
  - @opengeni/storage@0.2.69

## 0.5.10

### Patch Changes

- Updated dependencies [55f6ad0]
  - @opengeni/db@0.28.1

## 0.5.9

### Patch Changes

- Updated dependencies [49c7f9c]
- Updated dependencies [5b6d36e]
- Updated dependencies [6eb0b23]
- Updated dependencies [5b6d36e]
  - @opengeni/db@0.28.0
  - @opengeni/config@0.11.0
  - @opengeni/contracts@0.39.0
  - @opengeni/storage@0.2.68

## 0.5.8

### Patch Changes

- Updated dependencies [cbf165a]
  - @opengeni/db@0.27.12

## 0.5.7

### Patch Changes

- Updated dependencies [8135dbb]
- Updated dependencies [17643a5]
  - @opengeni/config@0.10.14
  - @opengeni/db@0.27.11
  - @opengeni/storage@0.2.67

## 0.5.6

### Patch Changes

- Updated dependencies [69bc207]
- Updated dependencies [144fd9e]
- Updated dependencies [c0f8e40]
  - @opengeni/db@0.27.10
  - @opengeni/contracts@0.38.3
  - @opengeni/config@0.10.13
  - @opengeni/storage@0.2.66

## 0.5.5

### Patch Changes

- Updated dependencies [4502474]
  - @opengeni/contracts@0.38.2
  - @opengeni/db@0.27.9
  - @opengeni/config@0.10.12
  - @opengeni/storage@0.2.65

## 0.5.4

### Patch Changes

- Updated dependencies [dfa3aef]
  - @opengeni/db@0.27.8

## 0.5.3

### Patch Changes

- Updated dependencies [c29fd4c]
  - @opengeni/db@0.27.7

## 0.5.2

### Patch Changes

- @opengeni/db@0.27.6

## 0.5.1

### Patch Changes

- Updated dependencies [c9d8b69]
  - @opengeni/contracts@0.38.1
  - @opengeni/db@0.27.5
  - @opengeni/config@0.10.11
  - @opengeni/storage@0.2.64

## 0.5.0

### Minor Changes

- bef5920: Add subject-scoped Workspace State preference and document-authority inventory
  metadata plus a canonical, explicitly sanitized export API and SDK method.

### Patch Changes

- Updated dependencies [b6e39fc]
- Updated dependencies [bef5920]
  - @opengeni/db@0.27.4
  - @opengeni/config@0.10.10
  - @opengeni/contracts@0.38.0
  - @opengeni/storage@0.2.63

## 0.4.1

### Patch Changes

- d5df927: Keep legacy personal document checks anchored to their originating workspace and fail closed for incomplete, non-canonical, overlong, or unknown authority tuples.
  - @opengeni/db@0.27.3

## 0.4.0

### Minor Changes

- fd13ba9: Add one immutable organization, workspace, or personal document destination contract for connector configuration, and make Google Drive persist and consume that authority independently from optional collections.

### Patch Changes

- Updated dependencies [fd13ba9]
  - @opengeni/contracts@0.37.0
  - @opengeni/config@0.10.9
  - @opengeni/db@0.27.2
  - @opengeni/storage@0.2.62

## 0.3.4

### Patch Changes

- Updated dependencies [abe0de6]
  - @opengeni/config@0.10.8
  - @opengeni/contracts@0.36.1
  - @opengeni/db@0.27.1
  - @opengeni/storage@0.2.61

## 0.3.3

### Patch Changes

- Updated dependencies [00f7d3b]
  - @opengeni/contracts@0.36.0
  - @opengeni/db@0.27.0
  - @opengeni/config@0.10.7
  - @opengeni/storage@0.2.60

## 0.3.2

### Patch Changes

- Updated dependencies [b121e7c]
  - @opengeni/contracts@0.35.0
  - @opengeni/db@0.26.0
  - @opengeni/config@0.10.6
  - @opengeni/storage@0.2.59

## 0.3.1

### Patch Changes

- Updated dependencies [b83af7a]
  - @opengeni/contracts@0.34.0
  - @opengeni/db@0.25.0
  - @opengeni/config@0.10.5
  - @opengeni/storage@0.2.58

## 0.3.0

### Minor Changes

- d1f0c3d: Add immutable organization, workspace, and initiating-user personal authority to Documents and chunks; filter retrieval by exact account and authority before ranking; require exact account-admin authority for organization publication; and preserve authority through a drained API, worker, and indexing-workflow cutover.
- 1d0f2ae: Expose one effective document retrieval contract across REST, SDK, and MCP that binds the immutable initiating subject outside caller input, filters organization/workspace/personal authority before ranking, and preserves source plus authorization provenance in typed results.

### Patch Changes

- Updated dependencies [d1f0c3d]
- Updated dependencies [1d0f2ae]
- Updated dependencies [088d7cb]
- Updated dependencies [74bd3a5]
- Updated dependencies [3e4842d]
  - @opengeni/contracts@0.33.0
  - @opengeni/db@0.24.0
  - @opengeni/config@0.10.4
  - @opengeni/storage@0.2.57

## 0.2.72

### Patch Changes

- Updated dependencies [13b961e]
- Updated dependencies [ecc4288]
- Updated dependencies [e03397d]
- Updated dependencies [4f15920]
- Updated dependencies [acfcf38]
- Updated dependencies [3baaebd]
  - @opengeni/contracts@0.32.0
  - @opengeni/db@0.23.0
  - @opengeni/config@0.10.3
  - @opengeni/storage@0.2.56

## 0.2.71

### Patch Changes

- Updated dependencies [e62495f]
- Updated dependencies [b4982fa]
- Updated dependencies [b4982fa]
  - @opengeni/contracts@0.31.2
  - @opengeni/config@0.10.2
  - @opengeni/db@0.22.3
  - @opengeni/storage@0.2.55

## 0.2.70

### Patch Changes

- Updated dependencies [9c4d73d]
  - @opengeni/config@0.10.1
  - @opengeni/contracts@0.31.1
  - @opengeni/db@0.22.2
  - @opengeni/storage@0.2.54

## 0.2.69

### Patch Changes

- Updated dependencies [8b3e46f]
  - @opengeni/config@0.10.0
  - @opengeni/contracts@0.31.0
  - @opengeni/db@0.22.1
  - @opengeni/storage@0.2.53

## 0.2.68

### Patch Changes

- 4fcb6af: Add a bounded, resumable Google Drive inventory and deterministic export planner with
  tenant- and permission-bound versioned checkpoints.
- Updated dependencies [e07eb52]
  - @opengeni/db@0.22.0

## 0.2.67

### Patch Changes

- 6500589: Automatically restore and list each workspace's Default document collection so uploads no longer require creating a base first, while preserving existing base-specific APIs and optional collection organization.

## 0.2.66

### Patch Changes

- Updated dependencies [2321119]
  - @opengeni/contracts@0.30.0
  - @opengeni/db@0.21.0
  - @opengeni/config@0.9.3
  - @opengeni/storage@0.2.52

## 0.2.65

### Patch Changes

- Updated dependencies [dd71248]
- Updated dependencies [03ed7eb]
  - @opengeni/contracts@0.29.0
  - @opengeni/db@0.20.0
  - @opengeni/config@0.9.2
  - @opengeni/storage@0.2.51

## 0.2.64

### Patch Changes

- Updated dependencies [1a2d41f]
  - @opengeni/db@0.19.0

## 0.2.63

### Patch Changes

- Updated dependencies [659b3ff]
  - @opengeni/contracts@0.28.1
  - @opengeni/db@0.18.1
  - @opengeni/config@0.9.1
  - @opengeni/storage@0.2.50

## 0.2.62

### Patch Changes

- Updated dependencies [d4d8960]
- Updated dependencies [ec0bc02]
- Updated dependencies [5a4c559]
  - @opengeni/contracts@0.28.0
  - @opengeni/db@0.18.0
  - @opengeni/config@0.9.0
  - @opengeni/storage@0.2.49

## 0.2.61

### Patch Changes

- Updated dependencies [8243ffe]
  - @opengeni/config@0.8.1
  - @opengeni/db@0.17.1
  - @opengeni/storage@0.2.48

## 0.2.60

### Patch Changes

- Updated dependencies [dcc35c5]
- Updated dependencies [1ec9912]
  - @opengeni/config@0.8.0
  - @opengeni/contracts@0.27.0
  - @opengeni/db@0.17.0
  - @opengeni/storage@0.2.47

## 0.2.59

### Patch Changes

- Updated dependencies [c52acc0]
  - @opengeni/config@0.7.22
  - @opengeni/contracts@0.26.1
  - @opengeni/db@0.16.2
  - @opengeni/storage@0.2.46

## 0.2.58

### Patch Changes

- Updated dependencies [02fb98c]
  - @opengeni/db@0.16.1

## 0.2.57

### Patch Changes

- Updated dependencies [b5175a8]
- Updated dependencies [f413e6c]
  - @opengeni/db@0.16.0
  - @opengeni/contracts@0.26.0
  - @opengeni/config@0.7.21
  - @opengeni/storage@0.2.45

## 0.2.56

### Patch Changes

- Updated dependencies [0199108]
- Updated dependencies [42428a2]
- Updated dependencies [7b65614]
- Updated dependencies [b2e975f]
- Updated dependencies [9f3b931]
  - @opengeni/contracts@0.25.0
  - @opengeni/db@0.15.6
  - @opengeni/config@0.7.20
  - @opengeni/storage@0.2.44

## 0.2.55

### Patch Changes

- Updated dependencies [710b081]
- Updated dependencies [b7df541]
  - @opengeni/contracts@0.24.3
  - @opengeni/config@0.7.19
  - @opengeni/db@0.15.5
  - @opengeni/storage@0.2.43

## 0.2.54

### Patch Changes

- Updated dependencies [84fb671]
- Updated dependencies [96eb64b]
  - @opengeni/db@0.15.4
  - @opengeni/config@0.7.18
  - @opengeni/contracts@0.24.2
  - @opengeni/storage@0.2.42

## 0.2.53

### Patch Changes

- Updated dependencies [510eae3]
  - @opengeni/db@0.15.3

## 0.2.52

### Patch Changes

- ddff8db: Add the read-only Workspace State inventory with bounded, authorization-scoped
  Documents aggregates and a deterministic metadata-only Memory projection. The
  projection explicitly labels legacy `knowledge_memories` preference-kind counts
  as non-authoritative observations while preserving the structured preference
  registry as the sole active preference authority.
- Updated dependencies [ddff8db]
- Updated dependencies [0a9a6eb]
  - @opengeni/contracts@0.24.1
  - @opengeni/db@0.15.2
  - @opengeni/config@0.7.17
  - @opengeni/storage@0.2.41

## 0.2.51

### Patch Changes

- Updated dependencies [6d167f4]
  - @opengeni/db@0.15.1
  - @opengeni/config@0.7.16
  - @opengeni/storage@0.2.40

## 0.2.50

### Patch Changes

- Updated dependencies [a19971e]
- Updated dependencies [1f6f13f]
  - @opengeni/config@0.7.15
  - @opengeni/contracts@0.24.0
  - @opengeni/db@0.15.0
  - @opengeni/storage@0.2.39

## 0.2.49

### Patch Changes

- Updated dependencies [848287f]
  - @opengeni/db@0.14.7

## 0.2.48

### Patch Changes

- Updated dependencies [2aca964]
  - @opengeni/db@0.14.6

## 0.2.47

### Patch Changes

- Updated dependencies [ad0bdc3]
  - @opengeni/contracts@0.23.1
  - @opengeni/db@0.14.5
  - @opengeni/config@0.7.14
  - @opengeni/storage@0.2.38

## 0.2.46

### Patch Changes

- Updated dependencies [ea38a4c]
  - @opengeni/db@0.14.4

## 0.2.45

### Patch Changes

- Updated dependencies [33dc88f]
- Updated dependencies [36451c6]
  - @opengeni/contracts@0.23.0
  - @opengeni/config@0.7.13
  - @opengeni/db@0.14.3
  - @opengeni/storage@0.2.37

## 0.2.44

### Patch Changes

- Updated dependencies [1c4018e]
  - @opengeni/config@0.7.12
  - @opengeni/contracts@0.22.1
  - @opengeni/db@0.14.2
  - @opengeni/storage@0.2.36

## 0.2.43

### Patch Changes

- Updated dependencies [6908a7a]
  - @opengeni/db@0.14.1

## 0.2.42

### Patch Changes

- Updated dependencies [29ad09b]
- Updated dependencies [b2e23f3]
- Updated dependencies [dfc3235]
  - @opengeni/contracts@0.22.0
  - @opengeni/db@0.14.0
  - @opengeni/config@0.7.11
  - @opengeni/storage@0.2.35

## 0.2.41

### Patch Changes

- 519d93c: Add validated inline per-session skills and discover skills directly from already-materialized repository resources.
- Updated dependencies [519d93c]
  - @opengeni/contracts@0.21.0
  - @opengeni/config@0.7.10
  - @opengeni/db@0.13.4
  - @opengeni/storage@0.2.34

## 0.2.40

### Patch Changes

- Updated dependencies [110bb77]
  - @opengeni/config@0.7.9
  - @opengeni/contracts@0.20.2
  - @opengeni/db@0.13.3
  - @opengeni/storage@0.2.33

## 0.2.39

### Patch Changes

- Updated dependencies [8b8545e]
  - @opengeni/db@0.13.2

## 0.2.38

### Patch Changes

- Updated dependencies [ffd246c]
  - @opengeni/contracts@0.20.1
  - @opengeni/config@0.7.8
  - @opengeni/db@0.13.1
  - @opengeni/storage@0.2.32

## 0.2.37

### Patch Changes

- Updated dependencies [06a5801]
- Updated dependencies [9326255]
- Updated dependencies [5511c24]
  - @opengeni/contracts@0.20.0
  - @opengeni/db@0.13.0
  - @opengeni/config@0.7.7
  - @opengeni/storage@0.2.31

## 0.2.36

### Patch Changes

- Updated dependencies [9a8f793]
- Updated dependencies [c135339]
  - @opengeni/contracts@0.19.4
  - @opengeni/db@0.12.6
  - @opengeni/config@0.7.6
  - @opengeni/storage@0.2.30

## 0.2.35

### Patch Changes

- Updated dependencies [a0f2442]
  - @opengeni/contracts@0.19.3
  - @opengeni/config@0.7.5
  - @opengeni/db@0.12.5
  - @opengeni/storage@0.2.29

## 0.2.34

### Patch Changes

- Updated dependencies [85cb323]
  - @opengeni/config@0.7.4
  - @opengeni/contracts@0.19.2
  - @opengeni/db@0.12.4
  - @opengeni/storage@0.2.28

## 0.2.33

### Patch Changes

- Updated dependencies [1386679]
- Updated dependencies [b7290a3]
- Updated dependencies [dcde939]
- Updated dependencies [5685f32]
- Updated dependencies [de20184]
  - @opengeni/db@0.12.3
  - @opengeni/config@0.7.3
  - @opengeni/contracts@0.19.1
  - @opengeni/storage@0.2.27

## 0.2.32

### Patch Changes

- Updated dependencies [7c6aa7c]
  - @opengeni/config@0.7.2
  - @opengeni/db@0.12.2
  - @opengeni/storage@0.2.26

## 0.2.31

### Patch Changes

- Updated dependencies [55c6559]
  - @opengeni/config@0.7.1
  - @opengeni/db@0.12.1
  - @opengeni/storage@0.2.25

## 0.2.30

### Patch Changes

- Updated dependencies [c549ed8]
- Updated dependencies [46bac05]
- Updated dependencies [860de22]
- Updated dependencies [5b57a2d]
  - @opengeni/contracts@0.19.0
  - @opengeni/db@0.12.0
  - @opengeni/config@0.7.0
  - @opengeni/storage@0.2.24

## 0.2.29

### Patch Changes

- Updated dependencies [744a93d]
- Updated dependencies [0ed0f01]
- Updated dependencies [b32938f]
  - @opengeni/config@0.6.10
  - @opengeni/contracts@0.18.1
  - @opengeni/db@0.11.0
  - @opengeni/storage@0.2.23

## 0.2.28

### Patch Changes

- Updated dependencies [0d60720]
- Updated dependencies [bdd531c]
  - @opengeni/config@0.6.9
  - @opengeni/contracts@0.18.0
  - @opengeni/db@0.10.7
  - @opengeni/storage@0.2.22

## 0.2.27

### Patch Changes

- Updated dependencies [524599e]
  - @opengeni/config@0.6.8
  - @opengeni/contracts@0.17.3
  - @opengeni/db@0.10.6
  - @opengeni/storage@0.2.21

## 0.2.26

### Patch Changes

- Updated dependencies [229902b]
  - @opengeni/db@0.10.5
  - @opengeni/config@0.6.7
  - @opengeni/storage@0.2.20

## 0.2.25

### Patch Changes

- Updated dependencies [4966649]
- Updated dependencies [cb188f9]
  - @opengeni/contracts@0.17.2
  - @opengeni/db@0.10.4
  - @opengeni/config@0.6.6
  - @opengeni/storage@0.2.19

## 0.2.24

### Patch Changes

- Updated dependencies [495c62c]
  - @opengeni/db@0.10.3

## 0.2.23

### Patch Changes

- Updated dependencies [ff23da5]
  - @opengeni/contracts@0.17.1
  - @opengeni/db@0.10.2
  - @opengeni/storage@0.2.18
  - @opengeni/config@0.6.5

## 0.2.22

### Patch Changes

- Updated dependencies [eed3438]
  - @opengeni/db@0.10.1

## 0.2.21

### Patch Changes

- Updated dependencies [d1dee7a]
  - @opengeni/contracts@0.17.0
  - @opengeni/config@0.6.4
  - @opengeni/db@0.10.0
  - @opengeni/storage@0.2.17

## 0.2.20

### Patch Changes

- Updated dependencies [b9cec61]
- Updated dependencies [c978676]
  - @opengeni/contracts@0.16.0
  - @opengeni/config@0.6.3
  - @opengeni/db@0.9.4
  - @opengeni/storage@0.2.16

## 0.2.19

### Patch Changes

- Updated dependencies [9f84cc9]
  - @opengeni/contracts@0.15.0
  - @opengeni/db@0.9.3
  - @opengeni/config@0.6.2
  - @opengeni/storage@0.2.15

## 0.2.18

### Patch Changes

- Updated dependencies [136227e]
- Updated dependencies [3aee519]
  - @opengeni/contracts@0.14.0
  - @opengeni/config@0.6.1
  - @opengeni/db@0.9.2
  - @opengeni/storage@0.2.14

## 0.2.17

### Patch Changes

- Updated dependencies [1f0ed18]
- Updated dependencies [00e1cdc]
  - @opengeni/db@0.9.1

## 0.2.16

### Patch Changes

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
  - @opengeni/db@0.9.0
  - @opengeni/storage@0.2.13

## 0.2.15

### Patch Changes

- Updated dependencies [77d65f9]
- Updated dependencies
- Updated dependencies [dbb6232]
- Updated dependencies [3e65c23]
  - @opengeni/db@0.8.0
  - @opengeni/config@0.5.3
  - @opengeni/contracts@0.12.0
  - @opengeni/storage@0.2.12

## 0.2.14

### Patch Changes

- Updated dependencies [28290a0]
  - @opengeni/db@0.7.5

## 0.2.13

### Patch Changes

- Updated dependencies [14ce2e3]
- Updated dependencies [053c5df]
- Updated dependencies [ec0697a]
  - @opengeni/config@0.5.2
  - @opengeni/db@0.7.4
  - @opengeni/contracts@0.11.0
  - @opengeni/storage@0.2.11

## 0.2.12

### Patch Changes

- Updated dependencies [b9dbb63]
  - @opengeni/db@0.7.3

## 0.2.11

### Patch Changes

- @opengeni/config@0.5.1
- @opengeni/db@0.7.2
- @opengeni/storage@0.2.10

## 0.2.10

### Patch Changes

- Updated dependencies [ea52b39]
  - @opengeni/db@0.7.1

## 0.2.9

### Patch Changes

- 0805620: Make active-sandbox pointer swaps establishment-safe. A swap or create-time seed to a target no turn can establish (a non-group Modal sibling, or an unknown backend kind) is now rejected before the epoch-fenced pointer commit with a typed rejection `code`, leaving the pointer and epoch untouched. At turn start a persisted pointer whose target is structurally unestablishable (a deleted sandbox row, a Modal sibling, or an enrollment-less selfhosted row) is reset to the session home under the epoch fence and announced with a new `session.route.reconciled` event, honoring a concurrent higher-epoch swap rather than clobbering it. A null pointer resolves to the session home backend, and the routing proxy's per-op cache is keyed on the full `(activeEpoch, activeSandboxId)` tuple so a clear-to-null re-lands the next op on home rather than a stale swapped-to session. Adds the optional `SwapActiveSandboxResponse.code` discriminant and the `session.route.reconciled` session event type to the public contracts and SDK wire types.
- b804fd4: Add provider-neutral git credential contracts and runtime sandbox token-file seeding for GitHub, GitLab, and Azure DevOps. Sandboxes now provision `gh`, `glab`, and `az` wrappers that read current token files at invocation time without storing token values in manifests.
- Updated dependencies [332ac15]
- Updated dependencies [ad4502a]
- Updated dependencies [ec508d4]
- Updated dependencies [477b2bb]
- Updated dependencies [04d7595]
- Updated dependencies [0805620]
- Updated dependencies [faf1487]
- Updated dependencies [13d0889]
- Updated dependencies [b125213]
- Updated dependencies [b804fd4]
- Updated dependencies [4a25bfc]
- Updated dependencies [4a25bfc]
- Updated dependencies [3148404]
- Updated dependencies [a0cb58f]
- Updated dependencies [e4d3569]
- Updated dependencies [810542f]
- Updated dependencies [5942493]
- Updated dependencies [726cf2c]
- Updated dependencies [a5f58f9]
- Updated dependencies [9d4283d]
  - @opengeni/db@0.7.0
  - @opengeni/config@0.5.0
  - @opengeni/contracts@0.10.0
  - @opengeni/storage@0.2.9

## 0.2.8

### Patch Changes

- Updated dependencies [1e7a243]
  - @opengeni/config@0.4.0
  - @opengeni/db@0.6.1
  - @opengeni/storage@0.2.8

## 0.2.7

### Patch Changes

- 602db89: Add Toolspace programmatic tool access for sandboxes.

  The new `toolspace:call` permission is an explicit, session-bound delegated grant for sandbox code. When `OPENGENI_TOOLSPACE_ENABLED=true`, worker turns mint a narrow `ogd_` token to a sandbox token file and expose `OPENGENI_TOOLSPACE_URL`; the first-party MCP route uses that token to compose the session's safe first-party, capability-backed, and per-session MCP tools, with approval-required tools denied as MCP `isError` results.

- Updated dependencies [602db89]
  - @opengeni/contracts@0.9.0
  - @opengeni/config@0.3.0
  - @opengeni/db@0.6.0
  - @opengeni/storage@0.2.7

## 0.2.6

### Patch Changes

- Updated dependencies [7bfe593]
- Updated dependencies [db468cc]
  - @opengeni/contracts@0.8.0
  - @opengeni/db@0.5.0
  - @opengeni/config@0.2.6
  - @opengeni/storage@0.2.6

## 0.2.5

### Patch Changes

- Updated dependencies [5ca067f]
  - @opengeni/contracts@0.7.0
  - @opengeni/config@0.2.5
  - @opengeni/db@0.4.1
  - @opengeni/storage@0.2.5

## 0.2.4

### Patch Changes

- Updated dependencies [dbe3a19]
- Updated dependencies [e513236]
  - @opengeni/config@0.2.4
  - @opengeni/contracts@0.6.0
  - @opengeni/db@0.4.0
  - @opengeni/storage@0.2.4

## 0.2.3

### Patch Changes

- Updated dependencies [15deca0]
  - @opengeni/contracts@0.5.0
  - @opengeni/db@0.3.0
  - @opengeni/config@0.2.3
  - @opengeni/storage@0.2.3

## 0.2.2

### Patch Changes

- 5962dd0: Republish the closure so published manifests reference `@opengeni/contracts@^0.4.0`. The previous `^0.3.0` ranges exclude 0.4.0 under 0.x caret semantics, causing consumers to nest a stale contracts copy that lacks the current export surface.
- Updated dependencies [5962dd0]
  - @opengeni/config@0.2.2
  - @opengeni/db@0.2.2
  - @opengeni/storage@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies [548e307]
  - @opengeni/contracts@0.4.0
  - @opengeni/config@0.2.1
  - @opengeni/db@0.2.1
  - @opengeni/storage@0.2.1

## 0.2.0

### Minor Changes

- 2170732: Publish the full Stage C `@opengeni/*` runtime closure to npm so external hosts can consume OpenGeni from published packages instead of vendored workspace tarballs.

  The release pipeline now builds every publishable package, rewrites every published `workspace:*` dependency to a concrete semver range, rewrites source entry points to dist entry points for every publishable package, and leaves only leaf-only non-runtime packages ignored.

### Patch Changes

- Updated dependencies [2170732]
  - @opengeni/config@0.2.0
  - @opengeni/db@0.2.0
  - @opengeni/storage@0.2.0
