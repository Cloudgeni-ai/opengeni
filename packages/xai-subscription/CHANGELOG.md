# @opengeni/xai-subscription

## 6.22.0

### Patch Changes

- @opengeni/network@6.22.0

## 6.21.0

### Patch Changes

- @opengeni/network@6.21.0

## 6.20.1

### Patch Changes

- @opengeni/network@6.20.1

## 6.20.0

### Patch Changes

- @opengeni/network@6.20.0

## 6.19.0

### Patch Changes

- @opengeni/network@6.19.0

## 6.18.0

### Patch Changes

- Updated dependencies [917393e]
  - @opengeni/network@6.18.0

## 6.17.0

### Patch Changes

- @opengeni/network@6.17.0

## 6.16.0

### Patch Changes

- 01feadc: SuperGrok requests present the current Grok CLI stable release (1.0.77), so xAI does not refuse them as an outdated client.
  - @opengeni/network@6.16.0

## 6.15.0

### Patch Changes

- @opengeni/network@6.15.0

## 6.14.0

### Patch Changes

- @opengeni/network@6.14.0

## 6.13.0

### Patch Changes

- @opengeni/network@6.13.0

## 6.12.0

### Patch Changes

- Updated dependencies [913e2b4]
  - @opengeni/network@6.12.0

## 6.11.0

### Patch Changes

- b1e049b: SuperGrok works again after xAI raised its minimum Grok CLI version. Requests now present the current Grok CLI stable release (1.0.70) instead of 1.0.3, which xAI refuses as outdated. When xAI raises its minimum again, the transport adopts the version its refusal names and retries the request once, so Grok turns keep working until the pin catches up; a daily workflow keeps the pin on the stable channel. A refusal that still persists fails the turn with the code `xai_client_outdated` and a plain message, and never marks the connected account as needing sign-in or as broken.
  - @opengeni/network@6.11.0

## 6.10.0

### Patch Changes

- Updated dependencies [b5201d5]
  - @opengeni/network@6.10.0

## 6.9.0

### Patch Changes

- @opengeni/network@6.9.0

## 6.8.0

### Patch Changes

- @opengeni/network@6.8.0

## 6.7.0

### Patch Changes

- @opengeni/network@6.7.0

## 6.6.0

### Patch Changes

- @opengeni/network@6.6.0

## 6.5.1

### Patch Changes

- @opengeni/network@6.5.0

## 6.4.0

### Patch Changes

- @opengeni/network@6.4.0

## 6.3.1

### Patch Changes

- @opengeni/network@6.3.0

## 6.2.1

### Patch Changes

- @opengeni/network@6.2.0

## 6.1.1

### Patch Changes

- @opengeni/network@6.1.0

## 6.0.2

### Patch Changes

- @opengeni/network@6.0.0

## 5.5.1

### Patch Changes

- @opengeni/network@5.5.0

## 5.4.2

### Patch Changes

- Updated dependencies [a57cfa8]
  - @opengeni/network@5.4.0

## 5.3.1

### Patch Changes

- Updated dependencies [4c6bf32]
  - @opengeni/network@5.3.0

## 5.2.1

### Patch Changes

- @opengeni/network@5.2.0

## 5.1.2

### Patch Changes

- @opengeni/network@5.1.0

## 5.0.2

### Patch Changes

- @opengeni/network@5.0.0

## 4.8.0

### Patch Changes

- @opengeni/network@4.8.0

## 4.7.2

### Patch Changes

- @opengeni/network@4.7.2

## 4.7.1

### Patch Changes

- @opengeni/network@4.7.1

## 4.7.0

### Patch Changes

- @opengeni/network@4.7.0

## 4.6.1

### Patch Changes

- @opengeni/network@4.6.0

## 4.5.0

### Patch Changes

- @opengeni/network@4.5.0

## 4.4.1

### Patch Changes

- @opengeni/network@4.4.0

## 4.3.1

### Patch Changes

- Updated dependencies [d1de8b4]
  - @opengeni/network@4.3.0

## 4.2.0

### Patch Changes

- @opengeni/network@4.2.0

## 4.1.3

### Patch Changes

- @opengeni/network@4.1.2

## 4.1.1

### Patch Changes

- @opengeni/network@4.1.0

## 4.0.4

### Patch Changes

- Updated dependencies [35dcfa0]
- Updated dependencies [b1b51e2]
- Updated dependencies [1d24639]
- Updated dependencies [a34aebb]
  - @opengeni/network@4.0.0

## 3.4.0

### Patch Changes

- @opengeni/network@3.4.0

## 3.3.0

### Patch Changes

- @opengeni/network@3.3.0

## 3.2.2

### Patch Changes

- @opengeni/network@3.2.0

## 3.1.2

### Patch Changes

- @opengeni/network@3.1.0

## 3.0.0

### Patch Changes

- @opengeni/network@3.0.0

## 2.0.1

### Patch Changes

- @opengeni/network@2.0.1

## 2.0.0

### Patch Changes

- 9975001: Prepare SuperGrok chat turns for the shared subscription core. A SuperGrok turn reads its provider route once: without the SuperGrok cutover it runs exactly as before; during maintenance it fails with typed copy; on the core it is placed, leased and funded like a Codex turn, every model request is reserved and settled before and after it goes out, and an unknown outcome is never replayed. The SuperGrok transport gains request identity and settlement hooks. Nothing changes today: no organization has the SuperGrok cutover, so SuperGrok and Codex behave exactly as before.
  - @opengeni/network@2.0.0

## 1.4.4

### Patch Changes

- @opengeni/network@1.4.4

## 1.4.3

### Patch Changes

- @opengeni/network@1.4.3

## 1.4.2

### Patch Changes

- @opengeni/network@1.4.2

## 1.4.1

### Patch Changes

- @opengeni/network@1.4.1

## 1.4.0

### Patch Changes

- @opengeni/network@1.4.0

## 1.3.0

### Patch Changes

- @opengeni/network@1.3.0

## 1.2.0

### Patch Changes

- @opengeni/network@1.2.0

## 1.1.0

### Patch Changes

- @opengeni/network@1.1.0

## 1.0.2

### Patch Changes

- @opengeni/network@1.0.1

## 1.0.0

### Major Changes

- Reset package versioning: every published `@opengeni/*` package now releases together at one shared version, starting at 1.0.0. Install all `@opengeni` packages at the same version. Earlier versions are retired.

## 0.1.6

### Patch Changes

- Updated dependencies [3cc26b5]
  - @opengeni/network@0.3.2

## 0.1.5

### Patch Changes

- 6a97313: Publish grok-4.7 as the SuperGrok subscription model so it matches the model the published `@opengeni/config` already expects.

## 0.1.4

### Patch Changes

- 107aa14: Support standard SDK/React conversations in Sites and sandbox previews, direct
  HTML/source uploads, exact deployment package pins, and embedded layout/queue
  defaults. Refresh exhausted Grok capacity after external resets.
- Updated dependencies [52cf486]
- Updated dependencies [92cdc31]
  - @opengeni/network@0.3.1

## 0.1.3

### Patch Changes

- Updated dependencies [876396d]
  - @opengeni/network@0.3.0

## 0.1.2

### Patch Changes

- Updated dependencies [16387c3]
  - @opengeni/network@0.2.3

## 0.1.1

### Patch Changes

- 79f57b5: Close terminal SuperGrok SSE streams deterministically; abort any accepted stream after a configurable interval without a complete valid event; and expose metadata-only durable lifecycle audits, bounded metrics, dashboard panels, and timeout alerting without replaying partial work.
