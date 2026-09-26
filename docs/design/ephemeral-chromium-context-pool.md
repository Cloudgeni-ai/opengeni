# Experimental ephemeral Chromium context pool

Status: experimental pool with an operator-disabled sandbox API integration.
Dedicated managed browsers remain the default. See the
[ephemeral BrowserSession contract](../architecture/ephemeral-browser-sessions.md)
for explicit admission and terminal-loss behavior. This is not a production
rollout or a durable BrowserSession storage mode.

`EphemeralChromiumContextPool` in `packages/browserd/src/chromium-context-pool.ts`
lets a trusted experiment own one freshly launched headless Chromium process
and up to six disposable incognito contexts. `createDriver` returns the normal
CDP driver with a context fence. It requires the exact pool authority partition;
the caller must partition by authenticated owner, workspace, network route,
proxy, launch configuration and workload trust. The key is an internal
construction check, not a replacement for API authorization. Never accept it
from a model or use this path for unrelated security principals.

The process launcher must own termination and must not attach to an existing
browser. Each lease has independent cookies, origin storage, targets,
permissions, downloads and controller generations. The driver filters target
inventory by `browserContextId`; target reads and mutations check that filtered
inventory before attaching or dispatching. All created tabs and metadata probes
use the lease context. Browser-level download settings, permission settings and
cancellation carry the context ID. Process-wide download events from unknown
frames/GUIDs are ignored. This currently excludes downloads from an untracked
subframe as well; subframe download attribution needs conformance before wider
use.

No private-profile snapshot/restore is supported. `runtimeSnapshot` rejects
before supervisor profile capture could proceed. There is no ComputerSession,
headed desktop, external-auth runner, checkpoint resume or persistent-profile
claim in this experiment. Popup targets inherit their parent Chromium context.
The underlying process still shares OS resources and a crash boundary: browser
contexts are not an OS sandbox or a security boundary between hostile tenants.

Ending a lease disposes its context; the last lease terminates the owned
process. Pool creation is serialized and capacity is bounded. An uncertain
context-create or transport failure terminates the generation and all leases;
no browser action is replayed. This conservative experiment treats transport
timeouts as generation failures too. A new experiment must construct a new
pool, new contexts and new controller authority. It cannot resume an old
identity by silently launching another process.

Before production integration, the public contract must explicitly represent
ephemeral storage and shared crash scope. Capability negotiation, authority
partitioning, quota accounting, lifecycle/recovery persistence and UI copy must
all agree. Do not wire the pool through generic `createDriver` injection while
advertising durable managed-browser capabilities.

Verification includes negative foreign/default target access, process-wide
foreign download events, scoped permission/download setup, owner mismatch,
concurrent capacity admission, lease release, uncertain creation and process
loss without replay. The opt-in real Chromium test covers rendered screenshots,
cookies/local storage, popup ownership and surviving peer closure:

```sh
OPENGENI_BROWSERD_E2E=1 bun test packages/browserd/test/chromium-context-pool.e2e.test.ts
```

An optional `OPENGENI_TEST_CHROME_PATH` selects the test Chromium executable.
This test creates and tears down its own temporary profile and local fixture.
It does not establish third-party OAuth, extensions, WebRTC, service-worker,
mobile or production-application conformance.
