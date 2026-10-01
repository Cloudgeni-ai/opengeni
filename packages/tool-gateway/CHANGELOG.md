# @opengeni/tool-gateway

## 0.1.17

### Patch Changes

- Updated dependencies [a6ff780]
- Updated dependencies [0bbe2e7]
- Updated dependencies [45d1301]
- Updated dependencies [45d1301]
- Updated dependencies [fd5fb34]
- Updated dependencies [b45621d]
- Updated dependencies [45d1301]
- Updated dependencies [f874217]
- Updated dependencies [45d1301]
- Updated dependencies [0bbe2e7]
- Updated dependencies [3545ca3]
- Updated dependencies [45d1301]
- Updated dependencies [0bbe2e7]
- Updated dependencies [0bbe2e7]
- Updated dependencies [45d1301]
- Updated dependencies [5b48f00]
- Updated dependencies [5b48f00]
- Updated dependencies [5b48f00]
  - @opengeni/contracts@5.5.0
  - @opengeni/observability@0.8.36

## 0.1.16

### Patch Changes

- 32598eb: Expose content-free MCP phase timings and host-owned outbound trace correlation across gateway, credential, transport and persistence boundaries. Preserve W3C sampling flags, credential header semantics, exact execution authority and existing retry behavior.
- b5a77df: Make rejected tool arguments actionable. When a call does not match the tool's advertised input schema, the gateway error now names each missing, mistyped, or unexpected property (for example `missing required property "context"`), reports up to eight problems plus a count of the rest, and never quotes argument values. `ToolGatewayInputValidationError` gains `issues`, `omittedIssueCount`, and `summary`. The accept/reject decision still stops at the first error; the all-errors pass runs only after a rejection, only for arguments up to 64 KiB serialized, and never runs a `pattern` on a string longer than that subschema's `maxLength`.

  A model MCP call rejected this way now reads "The tool was not called because its arguments do not match the tool's input schema: ... Correct the named properties and call the tool again." instead of "Please try again", so the model fixes the arguments rather than resending the same call. Other thrown MCP failures keep the existing wording. The workspace tool HTTP call and approval routes return the same summary on their `422` (`code: "validation_failed"`, `details.code: "invalid_tool_arguments"` with `issues` and `omittedIssueCount`); the previous body carried only the bare code as its message.

- Updated dependencies [01f50bf]
- Updated dependencies [3f9c757]
- Updated dependencies [378327b]
- Updated dependencies [872391f]
- Updated dependencies [aad6598]
- Updated dependencies [6146167]
- Updated dependencies [3f9c757]
- Updated dependencies [9732749]
- Updated dependencies [6f28afd]
- Updated dependencies [32598eb]
- Updated dependencies [a6854a7]
- Updated dependencies [b591ea1]
- Updated dependencies [a82657f]
- Updated dependencies [cabfc5e]
- Updated dependencies [8669490]
- Updated dependencies [7a08660]
- Updated dependencies [57f030c]
- Updated dependencies [3f9c757]
- Updated dependencies [3f9c757]
- Updated dependencies [f986809]
- Updated dependencies [1ea4c69]
- Updated dependencies [11151c6]
- Updated dependencies [30414a0]
- Updated dependencies [514f8ea]
- Updated dependencies [b28d5fa]
- Updated dependencies [e193b13]
- Updated dependencies [14990d0]
- Updated dependencies [bcd9988]
- Updated dependencies [d1f4724]
  - @opengeni/contracts@5.4.0
  - @opengeni/observability@0.8.35

## 0.1.15

### Patch Changes

- Updated dependencies [1842911]
- Updated dependencies [585f2c1]
- Updated dependencies [ec707de]
- Updated dependencies [3aab8f9]
  - @opengeni/contracts@5.3.0

## 0.1.14

### Patch Changes

- Updated dependencies [084616e]
- Updated dependencies [1a427e0]
- Updated dependencies [6eb431b]
- Updated dependencies [48a8774]
- Updated dependencies [e422b62]
- Updated dependencies [bd365b7]
  - @opengeni/contracts@5.2.0

## 0.1.13

### Patch Changes

- Updated dependencies [23f4717]
  - @opengeni/contracts@5.1.1

## 0.1.12

### Patch Changes

- Updated dependencies [d92af11]
- Updated dependencies [f60ca2b]
- Updated dependencies [86c710a]
- Updated dependencies [2f8bc58]
  - @opengeni/contracts@5.1.0

## 0.1.11

### Patch Changes

- 9d9b94b: Keep the published dependency closure aligned with the updated plugin removal
  contracts. The SDK exposes named removal outcomes and optional preview-token
  confirmation alongside the existing installation-version check.
- Updated dependencies [6d0a4de]
- Updated dependencies [c64a94f]
- Updated dependencies [1c924ed]
- Updated dependencies [c31a951]
- Updated dependencies [f90d628]
- Updated dependencies [aa09567]
- Updated dependencies [d1ab270]
- Updated dependencies [c8bb974]
- Updated dependencies [3fa175e]
- Updated dependencies [332a02d]
- Updated dependencies [132b945]
- Updated dependencies [779b16b]
- Updated dependencies [1cb688d]
- Updated dependencies [621201d]
- Updated dependencies [f90d628]
- Updated dependencies [1bfb6a4]
- Updated dependencies [7e2436a]
- Updated dependencies [9d9b94b]
- Updated dependencies [c66ba31]
- Updated dependencies [f7c9169]
- Updated dependencies [0ea365c]
  - @opengeni/contracts@5.0.0

## 0.1.10

### Patch Changes

- Updated dependencies [7746251]
- Updated dependencies [85cafd0]
  - @opengeni/contracts@4.1.0

## 0.1.9

### Patch Changes

- Updated dependencies [50ac837]
- Updated dependencies [ad9dc2f]
- Updated dependencies [750060c]
- Updated dependencies [da4a85f]
- Updated dependencies [123cf57]
- Updated dependencies [efeaa9c]
  - @opengeni/contracts@4.0.0

## 0.1.8

### Patch Changes

- e41027c: Add opt-in MCP operation outcome recovery through a configured read-only provider receipt tool. Persist exact operation identity before dispatch, retain original invocation outcomes separately from late receipts, and revalidate current authority across accepted attempts without replaying mutations. Preserve arbitrary SDK call IDs as correlation rather than replacing UUID operation identity.

  Apply the additive operation-ledger migration and runtime-role provisioning, and upgrade all claim-capable workers to the membership-first lock order before enabling provider mappings. Providers must implement the documented observation contract; unsupported providers and historical operations without captured authority are not automatically recoverable.

- Updated dependencies [4e2b59d]
- Updated dependencies [488a69b]
- Updated dependencies [935af4e]
- Updated dependencies [d08dbb6]
  - @opengeni/contracts@3.1.0

## 0.1.7

### Patch Changes

- Updated dependencies [e1a50ba]
  - @opengeni/contracts@3.0.2

## 0.1.6

### Patch Changes

- Updated dependencies [6a60a58]
  - @opengeni/contracts@3.0.1

## 0.1.5

### Patch Changes

- Updated dependencies [cffd21b]
- Updated dependencies [f8be7df]
- Updated dependencies [cffd21b]
  - @opengeni/contracts@3.0.0

## 0.1.4

### Patch Changes

- Updated dependencies [1b0f4f2]
  - @opengeni/contracts@2.15.2

## 0.1.3

### Patch Changes

- Updated dependencies [068be26]
- Updated dependencies [2fa33e4]
  - @opengeni/contracts@2.15.1

## 0.1.2

### Patch Changes

- Updated dependencies [231b103]
- Updated dependencies [392c575]
- Updated dependencies [9827c25]
- Updated dependencies [5904fd1]
- Updated dependencies [14dd6fe]
  - @opengeni/contracts@2.15.0

## 0.1.1

### Patch Changes

- d8a70ec: Unify first-party and integration tools behind one workspace gateway for MCP, model execution, Codemode, SDK, and browser clients; require host-confirmed SDK approval for human-gated model calls, keep Codemode claims live through gateway preparation, and deduplicate reclaimed tool-created events; add opt-in resource-bound MCP OAuth; ship governed self-contained HTML Sites with retained source, version rollback, an exact-version direct-call tool allowlist, and a native Site-authoring Skill; and default Modal self-hosts to OpenGeni's public digest-pinned desktop runtime image.
- Updated dependencies [22a6704]
- Updated dependencies [4536385]
- Updated dependencies [7dac7e3]
- Updated dependencies [fa2b99a]
- Updated dependencies [fa12951]
- Updated dependencies [c1dc59b]
- Updated dependencies [1fc0889]
- Updated dependencies [d06450c]
- Updated dependencies [d9dbd5d]
- Updated dependencies [c69ad5f]
- Updated dependencies [1c4b707]
- Updated dependencies [c90f3fc]
- Updated dependencies [414946c]
- Updated dependencies [0c39126]
- Updated dependencies [0c39126]
- Updated dependencies [575af5b]
- Updated dependencies [6de9fe3]
- Updated dependencies [cda46e8]
- Updated dependencies [b1d3673]
- Updated dependencies [2fb17fd]
- Updated dependencies [3a29372]
- Updated dependencies [107aa14]
- Updated dependencies [d8a70ec]
- Updated dependencies [0a81cc8]
  - @opengeni/contracts@2.14.0
