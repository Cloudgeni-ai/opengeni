# Experimental ephemeral BrowserSessions

This opt-in experiment exposes the Chromium context pool through the existing BrowserSession API. It does not change default session storage or enable pooling in production.

## Explicit admission

A caller requests `storageMode: "ephemeral_context"` together with `headless: true`. The API must have `OPENGENI_EXPERIMENTAL_BROWSER_CONTEXT_POOL_ENABLED=true`; its sandbox browserd must independently have `OPENGENI_BROWSERD_EPHEMERAL_CONTEXT_POOL=1`. Both default off. The first implementation supports managed Chromium in a sandbox group only. Attached browsers, native connected machines, external providers, identities, revisions, network routes and linked ComputerSessions are rejected.

Omitting `storageMode` means `private_profile`, including when `identityId` is null. Existing private profiles retain their normal dedicated process and checkpoint behavior. Agent browser reuse matches storage mode, so opting into an ephemeral session never selects an existing private profile. An explicit existing session cannot have its storage mode changed.

The persisted discriminator is the versioned driver ID `opengeni.cdp.ephemeral-context.v1`, exposed through the existing BrowserSession response. `browserSessionStorageMode()` projects it to the public request enum. The create-operation digest includes that driver ID; a replay cannot change storage modes. No database migration or reinterpretation of existing rows is required.

## Partition and lifecycle

The API derives an opaque partition using its authority secret and the account, workspace, creating subject, sandbox group, concrete placement instance and versioned fixed launch configuration. Callers cannot supply a partition. Browserd additionally partitions by the selected executable and fixed headless/default-egress configuration. Different creating subjects or placements never share a Chromium process. Within a partition, up to six contexts share a process; capacity refusal never evicts another session.

Each context fences target discovery, target operations, permissions and download events. Incognito contexts separate cookies and local storage. They share Chromium's process crash boundary and are **not an operating-system security boundary**; the partition is for one trusted principal. A crash ends every context in that pool. A new browser session may start a fresh pool, but existing context identity and mutations are never restored or replayed.

The controller persists a generation-issued marker before launching each ephemeral session. A controller restart cannot recreate that BrowserSession ID, even if its first create response was lost. Terminal generations disappear from controller inventory. A subsequent authenticated API operation marks the matching persisted generation lost and releases its placement holder. A stale failure cannot retire a newer generation. Read retries and controller recovery are disabled for ephemeral sessions.

Checkpoint, suspend/resume and identity publication are unavailable. These capability restrictions are assigned by the database boundary, regardless of caller-supplied capabilities. Ending one context preserves its peers; ending the last context awaits actual owned-process termination. Never migrate an existing signed-in actor into this mode.

## Verification

The focused admission tests cover disabled operators, invalid combinations and partition authority. The runtime tests prevent reuse across modes. `packages/browserd/test/ephemeral-supervisor.e2e.test.ts` launches three contexts in two processes, checks target fencing, crashes only a fixture-owned process, verifies its peers become terminal while the other partition survives, and refuses recreation after controller restart.

`test/live/ephemeral-browser-session.live.ts` is the disposable HTTP/PostgreSQL/sandbox acceptance test. It must pass against the exact candidate controller before rollout consideration. Run only in a dedicated test database and disposable sandbox image. Production enablement requires independent authority/replay review and workload-specific resource measurements; synthetic savings do not imply a universal ratio.
