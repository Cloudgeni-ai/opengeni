# OpenGeni Sandbox Backend Wiring — Grounded Change-Surface Map

## 1. The current wiring path (end-to-end, cited)

**Backend selection happens in exactly one factory:** `createSandboxClient(settings, environment)` at `packages/runtime/src/index.ts:763-795`. It is a flat `if`-chain over `settings.sandboxBackend`, wiring only three branches:
- `"docker"` → `withDockerNetwork(new DockerSandboxClient({image, exposedPorts}), dockerNetwork)` (763:765-768)
- `"modal"` → `new ModalSandboxClient({appName, timeoutMs, exposedPorts, env, image?, tokenId?, tokenSecret?, environment?})` (763:770-789)
- `"local"` → `new UnixLocalSandboxClient()` (763:791-792)
- fallback → `return undefined` (`"none"` = no sandbox) (763:794)

Imports the branches depend on: `DockerSandboxClient`, `UnixLocalSandboxClient` from `@openai/agents/sandbox/local` (`packages/runtime/src/index.ts:27-31`); `ModalCloudBucketMountStrategy, ModalImageSelector, ModalSandboxClient` from `@openai/agents-extensions/sandbox/modal` (`:57`). **Adding a provider = a new import line + a new `if` branch here.**

**`createSandboxClient` is called from one place in the hot path:** `runAgentStream` at `packages/runtime/src/index.ts:1003-1051` — `const rawClient = overrides.sandboxClient ?? createSandboxClient(settings, environment)` (`:1006`). This is the **ownership-inversion seam #1**: today `runAgentStream` *builds and discards* a client per run unless `overrides.sandboxClient` is passed. `RunAgentStreamOptions` (`:968-971`) already exposes `sandboxClient?` and `sandboxEnvironment?`, so the in-worker `SandboxOwner` can inject an externally-owned client without a signature change. The sandbox session state is threaded at `:1028-1031` (`prepared.sandboxSessionState ?? restoredSandboxSessionState(...)`) and attached to `runOptions.sandbox = {client, sessionState}` at `:1044-1048` — **seam #2** for injecting an externally-owned `{client, sessionState}`.

**Client decoration stack** (each wraps the raw client, re-exposing the SDK's optional methods via spread — these are the functions the task asked about, and every one must be preserved for new backends):
- `withDockerNetwork` (`:797-820`) — Docker-only; re-spreads `create/resume/delete/serializeSessionState/canPersistOwnedSessionState/canReusePreservedOwnedSession/deserializeSessionState`.
- `withManifestRefreshOnResume` (`:1090-...`, applied at `:1007`) — same spread pattern at `:1104-1107`.
- `withSandboxFileDownloads` (applied `:1012`) and `withSandboxLifecycleHooks` (applied `:1018`) — spread at `:1213-1216` and `:1786-1789`.

**Resume / serialize / envelope plumbing:**
- `restoredSandboxSessionState(state, client)` (`:1637-1658`) — reads SDK-internal `_sandbox` off a RunState, asserts `client.backendId === entry.backendId` (`:1654`), then `deserializeSandboxSessionStateEnvelope`.
- `sandboxStateEntryFromRunState(state)` (`:1665-1683`) — extracts the plain-JSON envelope (provider handle / snapshot ref / manifest) for storage.
- `restoredSandboxSessionStateFromEntry(entry, client)` (`:1690-1698`) — items-mode rebuild; same `backendId` assertion (`:1694`).
- `deserializeSandboxSessionStateEnvelope(client, envelope)` (`:1700-1725`) — calls `client.deserializeSessionState({...providerState, manifest, snapshot, exposedPorts, ...})`. **This is backend-agnostic already** — works for any provider whose client implements `deserializeSessionState`. The envelope contains `exposedPorts: Record<string, ExposedPortEndpoint>` (`:1714,1723`), which is exactly the desktop-tunnel persistence the Channel-B design needs.

## 2. Type/contract enums to extend (every place the 4-value enum is declared)

`SandboxBackend = z.enum(["docker","modal","local","none"])` is declared/duplicated in **three** packages — all must grow the new providers (`daytona`, `runloop`, `e2b`, `blaxel`, `cloudflare`, `vercel`):
- `packages/contracts/src/index.ts:13-14` (the API/wire enum; re-used at `:696`, `:711`, `:812`, `:1244`, `:1326` for `SessionTurn`, `UpdateSessionTurnRequest`, CreateSession, etc.)
- `packages/deployment/src/index.ts:34-35` (the deployment-contract enum; used by `SandboxSpec.backend` at `:184`)
- The config `SandboxBackend` is imported from contracts and used at `packages/config/src/index.ts:235` (`sandboxBackend: SandboxBackend.default("docker")`).

**DB stores it as free-text** (`sandbox_backend text NOT NULL`, `packages/db/src/schema.ts:117` for `sessions`, `:260` for `sessionTurns`), cast as `SandboxBackend` on read (`packages/db/src/index.ts:3549,3592`) — so no migration is needed for the enum itself, only the zod literals.

**API/MCP entry validation:** `apps/api/src/routes/sessions.ts:252` (turn update) and `apps/api/src/mcp/server.ts:528` (`sandboxBackend: z4.string().optional()` — looser, accepts anything). CreateSession request validates via the contracts enum. Per-session/per-turn override already flows: `createAndStartSession` (`apps/api/src/domain/sessions.ts:56,97,116`), turn resolution `turn.sandboxBackend ?? settings.sandboxBackend` (`apps/worker/src/activities/scheduled-tasks.ts:60`), and `runSettings.sandboxBackend = turn.sandboxBackend` (`apps/worker/src/activities/agent-turn.ts:366`).

## 3. Per-provider config + secret needs (config package)

**Settings schema** (`packages/config/src/index.ts:235-244`) today has `sandboxBackend`, `dockerImage/dockerExposedPorts/dockerNetwork`, `modalAppName/modalImageRef/modalTimeoutSeconds/modalTokenId/modalTokenSecret/modalEnvironment`. **Env var mapping** at `:472-481` (`OPENGENI_SANDBOX_BACKEND`, `OPENGENI_DOCKER_*`, `OPENGENI_MODAL_*`). **Cross-field validation** at `:985-986` (Modal token id/secret both-or-neither).

New settings fields + `OPENGENI_*` env entries + factory branches needed, derived from the SDK client option interfaces (cited from `@openai/agents-extensions@0.11.6` `dist/sandbox/<p>/sandbox.d.ts`):

| Provider | SDK import subpath | Constructor option iface | Required secret/config | Optional knobs (from iface) | Lifetime/desktop notes |
|---|---|---|---|---|---|
| **daytona** | `@openai/agents-extensions/sandbox/daytona` | `DaytonaSandboxClientOptions` | `apiKey`, `apiUrl?` | `image`, `exposedPorts`, `exposedPortUrlTtlS`, `target`, `autoStopInterval`, `timeoutSec`, `sandboxSnapshotName`, `env` | desktop-capable; `resolveExposedPort` real |
| **runloop** | `.../runloop` | `RunloopSandboxClientOptions` | `apiKey`, `baseUrl?` | `blueprintName/Id`, `exposedPorts`, **`tunnel?: boolean\|Record`**, `managedSecrets`, `timeouts`, `env` | desktop-capable; `tunnel` flag is the Channel-B hook |
| **e2b** | `.../e2b` | `E2BSandboxClientOptions` | `E2B_API_KEY` (SDK reads env; no explicit `apiKey` field) | `template`, `exposedPorts`, `timeout`, `timeoutAction:'pause'\|'kill'`, `allowInternetAccess`, `autoResume`, `env` | ships official XFCE+VNC+noVNC image |
| **blaxel** | `.../blaxel` | `BlaxelSandboxClientOptions` | `apiKey` | `image`, `region`, `ports`, **`exposedPortPublic`**, `exposedPortUrlTtlS`, `memory`, `ttl`, `env` | ships official XFCE+VNC+noVNC; `exposedPortPublic` governs fan-out URL |
| **cloudflare** | `.../cloudflare` | `CloudflareSandboxClientOptions` | **`workerUrl` (required)**, `apiKey?` | `exposedPorts`, `timeouts`, `mounts` | HEADLESS-ONLY (`resolveExposedPort` is a stub; `/workspace` root lock) |
| **vercel** | `.../vercel` | `VercelSandboxClientOptions` | `token`/`projectId`/`teamId` (also via SDK env) | `runtime`, `exposedPorts`, `timeoutMs`, `interactive`, `networkPolicy`, `env` | HEADLESS-ONLY (5h cap, no custom image, no PTY); `resolveRemoteExposedPort` returns a `string` |

**Modal** stays primary; its `ModalSandboxClientOptions` (`sandbox.d.ts:94-115`) also exposes `idleTimeoutMs` (the "idle timeout" the task referenced — note OpenGeni currently wires only `timeoutMs` at `:773`, **not** `idleTimeoutMs`; that field is unmapped today and is a config gap to fill) and `workspacePersistence:'tar'|'snapshot_filesystem'|'snapshot_directory'` (the 24h snapshot-rollover lever).

**Peer deps to add** (`@openai/agents-extensions` declares them as optional peers — `package.json` peerDependenciesMeta all `optional:true`): `@daytonaio/sdk@^0.162.0`, `@runloop/api-client@^1.16.2`, `@e2b/code-interpreter@^2.3.3` + `e2b@^2.14.1`, `@blaxel/core@^0.2.82`, `@vercel/sandbox@^1.9.3`, (`@cloudflare/sandbox` is bundled, no peer). Add to `packages/runtime/package.json` (today only `@openai/agents-extensions@^0.11.6` + `modal@^0.7.4` at `:15-16`).

## 4. Deployment package (`packages/deployment/src/index.ts`) change points

- `SandboxSpec` (`:183-188`) — `backend` uses the enum; `preparationProfiles` and `envAllowlist` already generic.
- **Per-backend required-env declaration** — currently a single `if (contract.sandbox.backend === "modal")` block at **two** locations: `:863-864` (`requiredRuntimeEnvVars`) and `:1419-1428` (`buildRuntimeEnv` / the actual env rendering). Each new provider needs an analogous block pushing its `requiredEnv`/`valueEnv` entries.
- `valueEnv("OPENGENI_SANDBOX_BACKEND", contract.sandbox.backend)` at `:1349` (no change) and Helm value `config.OPENGENI_SANDBOX_BACKEND` at `:1546`.
- Profile defaults that hardcode a backend: `:342` and `:699`/`:713` use `modal`; `:441` uses `docker`; the rest `none` (`:455,484,522,551,589,618,656,685,727`). New desktop-capable profiles may want `daytona`/`e2b`/etc.
- `sandbox-readiness` deploy check at `:768` (`backend !== "none"`).

## 5. Runtime env-mount asymmetries to generalize (currently Modal/Docker-coded)

- `sandboxEnvironmentForRun` hardcodes `HOME ??= "/workspace"` only for `docker`/`modal` (`apps/worker/src/activities/environment.ts:80-82`). New providers have **different workspace roots** (runloop `/home/user` or `/root` per `DEFAULT_RUNLOOP_*` consts; blaxel/cloudflare `/workspace`; vercel/e2b differ) — `HOME` defaulting must become backend-aware.
- File-resource mount strategy `objectStorageFileMount` (`packages/runtime/src/index.ts:1481-1509`) throws for `azure-blob`+`modal` (`:1483-1484`) and for `aws-s3`/`gcs` (`:1497-1498`) — each new backend needs its mount/materialization story decided (`ModalCloudBucketMountStrategy` is Modal-specific at `:57`; S3/Azure mounts via `s3Mount`/`azureBlobMount` at `:1486,1501`).
- Signed-download gating `requiresSignedFileResourceDownloads` is keyed to `(docker,s3-compatible)` and `(modal,azure-blob)` pairs (`apps/worker/src/activities/agent-turn.ts:1059-1062`) — needs a row per new backend × storage combo.

## 6. Desktop (Channel B) — greenfield, no existing infra

Confirmed: **zero** `Xvfb/x11vnc/websockify/noVNC/XFCE` references anywhere in the repo. The only sandbox image is `docker/sandbox.Dockerfile` (headless: python/terraform/checkov/az/gh; `HOME=/workspace`, `WORKDIR /workspace`). A desktop image (Xvfb→x11vnc→websockify on one port) is net-new.

The SDK primitive for the tunnel URL is `session.resolveExposedPort(port): Promise<ExposedPortEndpoint>` (`@openai/agents-core/sandbox/session.d.ts:124`), where `ExposedPortEndpoint = {host, port, tls?, query?, protocol?, url?}` (`session.d.ts:9-17`), persisted in the envelope as `exposedPorts: Record<string, ExposedPortEndpoint>`. Helpers `recordExposedPortEndpoint`/`getRecordedExposedPortEndpoint`/`urlForExposedPort` (`session.d.ts:98-100`) and the extensions-side `assertConfiguredExposedPort`/`getCachedExposedPortEndpoint`/`parseExposedPortEndpoint` (`shared/ports.d.ts`) are the control-plane functions for minting the scoped direct-to-provider URL. **cloudflare/vercel `resolveExposedPort` are stubs** → these two are headless-tier only, matching the settled design.

## 7. Minimal change list to register all backends

1. `packages/runtime/src/index.ts:57` — add 6 import lines (one per provider subpath); `:763-795` — add 6 `if` branches in `createSandboxClient`.
2. `packages/contracts/src/index.ts:13`, `packages/deployment/src/index.ts:34` — extend both `SandboxBackend` enums (DB needs no migration; text column).
3. `packages/config/src/index.ts` — add per-provider settings fields (~after `:244`), env mappings (~after `:481`), and both-or-neither/required validation (~after `:986`); map Modal `idleTimeoutMs` (gap).
4. `packages/deployment/src/index.ts:863` and `:1419` — add per-provider required-env blocks.
5. `apps/worker/src/activities/environment.ts:80` — backend-aware `HOME`/workspace-root default.
6. `apps/worker/src/activities/agent-turn.ts:1059` and `packages/runtime/src/index.ts:1481` — extend storage×backend mount/signed-download matrices.
7. `packages/runtime/package.json:15` — add the 5 optional peer SDKs as deps.
8. Resume/serialize plumbing (`restoredSandboxSessionState` `:1637`, `restoredSandboxSessionStateFromEntry` `:1690`, `deserializeSandboxSessionStateEnvelope` `:1700`) is **already backend-generic** via `client.backendId` + `client.deserializeSessionState` — **no change needed** except that the `backendId` assertions (`:1654`, `:1694`) now correctly fence a session pinned to its original provider (important for the singleton-lease re-establish-from-envelope primitive).

**Key load-bearing finding:** the ownership-inversion the design needs is already 90% threaded — `RunAgentStreamOptions.sandboxClient`/`.sandboxEnvironment` (`packages/runtime/src/index.ts:968-971`) let an external `SandboxOwner` inject a pre-built client, and `runOptions.sandbox = {client, sessionState}` (`:1044-1048`) is the single attach point. The `sandbox_session_envelopes` table (`packages/db/src/schema.ts:360-370`, `uniqueIndex(workspaceId, sessionId)`) is the existing per-session envelope store the lease/recovery design can extend, and the `exposedPorts` field already persisted in the envelope (`packages/runtime/src/index.ts:1714,1723`) is the desktop-tunnel URL persistence surface.
