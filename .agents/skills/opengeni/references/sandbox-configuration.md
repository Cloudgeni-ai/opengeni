# Sandbox Configuration Reference

Use this as a checklist, not as a substitute for reading current code. Re-check source before making exact claims because backend names, env vars, and runtime behavior can change.

## Fast Discovery

Start with these searches:

```bash
rg -n "SandboxBackend|sandboxBackend|CAPABILITY_DESCRIPTORS|OPENGENI_SANDBOX|DockerSandboxClient|ModalSandboxClient|UnixLocalSandboxClient|createSandboxClient|buildManifest|s3Mount|gitRepo|collectSandboxEnvironment|sandboxEnvironmentForRun|azureCliLogin|withSandboxLifecycleHooks|GIT_ASKPASS|OPENGENI_OBJECT_STORAGE_SANDBOX_ENDPOINT" \
  packages apps docker .env.example README.md AGENTS.md
# Connected Machine (selfhosted) plumbing:
rg -n "selfhosted|OPENGENI_SANDBOX_SELFHOSTED_ENABLED|sandboxSelfhostedEnabled|establishSelfhostedTurnSession|resolveActiveSandboxBackend|repositoryUsesSandboxClone|toMachinePath|targetSandboxId|working_dir|workingDir" \
  packages apps agent docs/design/connected-machines
```

Then inspect:

- Contracts: `packages/contracts/src/index.ts` for allowed backend names, the per-backend `CAPABILITY_DESCRIPTORS` metadata table, and resource shapes.
- Config: `packages/config/src/index.ts` and `.env.example` for env var parsing/defaults/validation (including the `OPENGENI_SANDBOX_SELFHOSTED_ENABLED` gate).
- Connected Machine (`selfhosted`): `apps/worker/src/activities/agent-turn.ts` (the machine-primary turn branch + `resolveActiveSandboxBackend`), `packages/runtime/src/sandbox/selfhosted/session.ts` (`toMachinePath`, per-session `workingDir`), `repositoryUsesSandboxClone` in `packages/runtime/src/index.ts` (the clone-guard), the routes/services `apps/api/src/routes/{machines,enrollments}.ts` and `apps/api/src/sandbox/{machines,enrollment}.ts`, and the `agent/` Rust crate.
- Runtime: `packages/runtime/src/index.ts` for sandbox client creation, agent construction, manifest entries, resume behavior, resource mounts, and sandbox lifecycle hooks.
- Worker env: `apps/worker/src/activities/environment.ts` for per-run sandbox env, GitHub App token injection, git identity, and cloud credential behavior.
- Files: `apps/api/src/routes/files.ts`, `packages/storage/src/index.ts`, and file resource handling in runtime code.
- Docker image: `docker/sandbox.Dockerfile` and any helper scripts under `docker/`.
- Tests: search `sandbox`, `manifest`, `environment`, `file resource`, and backend names in `test/` and `packages/runtime/test/`.

## Configuration Axes

Separate sandbox configuration into these independent questions:

1. **Backend**: which OpenAI Agents SDK sandbox client runs the agent environment.
2. **Image/runtime**: what tools and OS packages are available inside that backend.
3. **Workspace manifest**: what repositories, files, skills, and environment variables are materialized under the workspace root.
4. **Credentials**: which host env vars are allowed into the sandbox and which short-lived tokens are minted per run.
5. **Object storage reachability**: which S3-compatible endpoint the host/API uses versus which endpoint the sandbox can reach.
6. **Network/ports**: which ports are exposed and whether any backend-specific network controls exist.
7. **Resume/lifetime**: how SDK run state and sandbox session state are serialized, resumed, or discarded.

## Backend Selection

Find the current backend enum (`SandboxBackend`) in `packages/contracts/src/index.ts`. Do not describe it as only Docker/Modal/local/none — the shipped enum is broader. As of this writing it has eleven members, added additively at the end (a contracts/SDK/deployment parity test pins their order): the original four (`docker`, `modal`, `local`, `none`), then six cloud backends (`daytona`, `runloop`, `e2b`, `blaxel`, `cloudflare`, `vercel`), then `selfhosted` (bring-your-own-compute — a user's own machine enrolled as a first-class sandbox; see the Connected Machine section below). Each backend is treated as an OpenAI Agents SDK sandbox client, and static per-backend metadata (tier, OS support, capabilities, lifetime, snapshot, workspace root, port exposure) lives in the `CAPABILITY_DESCRIPTORS` table in the same contracts file, so downstream code branches on that data, never a hard-coded backend name.

Typical meanings of the original four:

- **Docker**: local container sandbox. Requires building or providing a sandbox image.
- **Modal**: remote Modal sandbox backend through the Agents SDK extension.
- **Local**: Unix local sandbox client (its `backendId` is `unix_local`), useful for development but weaker isolation.
- **None**: no sandbox client; the agent runs without sandbox capabilities.

The six cloud backends (`daytona`, `runloop`, `e2b`, `blaxel`, `cloudflare`, `vercel`) are additional remote sandbox providers. Read their `CAPABILITY_DESCRIPTORS` rows for the exact tier, OS support, lifetime, and per-backend workspace root before documenting them — the workspace root is not universally `/workspace` (e2b is `/home/user`, vercel is `/vercel/sandbox`).

Verify exact backend names and options in current code before documenting them.

## Docker Sandbox Setup

Current local development expects the Docker sandbox image to be built before real sandbox runs:

```bash
docker build -f docker/sandbox.Dockerfile -t opengeni-sandbox:local .
```

The Docker backend is usually configured by:

```bash
OPENGENI_SANDBOX_BACKEND=docker
OPENGENI_DOCKER_IMAGE=opengeni-sandbox:local
# OPENGENI_DOCKER_EXPOSED_PORTS=3000,8080
```

Inspect `docker/sandbox.Dockerfile` for what the agent can use. The current image is infrastructure-oriented: Terraform, Checkov, Azure CLI, GitHub CLI, git, jq, curl, shell utilities, rclone/FUSE support, and an askpass helper for GitHub credentials. Do not promise these tools unless the Dockerfile still installs them.

## Modal Sandbox Setup

Modal configuration is separate from Docker image configuration. Current knobs include app name, timeout, optional image ref, optional Modal token pair, and optional Modal environment.

Typical shape:

```bash
OPENGENI_SANDBOX_BACKEND=modal
OPENGENI_MODAL_APP_NAME=opengeni-sandbox
OPENGENI_MODAL_TIMEOUT_SECONDS=900
# OPENGENI_MODAL_IMAGE_REF=ghcr.io/YOUR_ORG/opengeni-sandbox:dev
# OPENGENI_MODAL_TOKEN_ID=...
# OPENGENI_MODAL_TOKEN_SECRET=...
# OPENGENI_MODAL_ENVIRONMENT=...
```

When explaining Modal, say OpenGeni selects the Modal sandbox backend through the OpenAI Agents SDK extension. Do not imply that all Docker-only mounting or networking behavior is identical unless runtime code proves it.

## Local And None

`local` is a developer convenience and should be described as using the local machine as the execution environment. It is not the same isolation story as a container or remote sandbox.

`none` disables sandbox client wiring. It can still be useful for pure model/tool behavior, but do not claim filesystem/shell isolation or mounted resources when the current runtime skips sandbox construction.

## Connected Machine (`selfhosted`)

The `selfhosted` backend is a **Connected Machine**: a user's own machine, enrolled through the `agent/` Rust agent, that acts as a first-class *primary* compute target rather than a backend overlay on the managed sandbox. The machine itself is the box — OpenGeni cannot snapshot the user's disk, so the descriptor is `persistable:false` and there is no cold re-create; "resume" means the enrolled agent's live subject is reachable. The whole feature is gated by `OPENGENI_SANDBOX_SELFHOSTED_ENABLED` (`sandboxSelfhostedEnabled` in config, default off); with it off the machines/enrollment routes 404 and the enum value is effectively unreachable.

A machine-targeted turn is materially different from a cloud turn. The effective compute backend is resolved once at turn start (`resolveActiveSandboxBackend`); when it is `selfhosted`, the `machinePrimary` branch in `apps/worker/src/activities/agent-turn.ts` takes over:

- **No phantom cloud box.** The worker establishes a `SelfhostedSession` directly (`establishSelfhostedTurnSession`) and does NOT call `resumeBoxForTurn` — no Modal box is created, leased, or billed. The warm-seconds meter keys off the *effective* backend, so a machine accrues zero cloud warm-time (`selfhosted` has no configured warm rate).
- **No OpenGeni-minted token on the machine.** `sandboxEnvironmentForRun` is called with `skipGitHubToken` for a selfhosted-effective turn (`apps/worker/src/activities/environment.ts`), so the platform mints no GitHub App installation token and injects no git auth env. The machine uses its OWN git credentials. The token also never structurally crosses the wire — selfhosted exec does not forward the run environment onto the machine.
- **No repo clone onto the machine.** `repositoryUsesSandboxClone` (`packages/runtime/src/index.ts`) returns false for a selfhosted effective backend, so the repository-clone lifecycle hook is skipped. A connected machine already owns its filesystem, and the clone hook would otherwise write onto the user's real disk — so the platform must never `git clone` there.
- **Per-session working directory, not `/workspace`.** The machine runs the session under `sessions.working_dir` (added by migration `0027_session_working_dir.sql`). `packages/runtime/src/sandbox/selfhosted/session.ts` keeps a virtual `/workspace` root purely for manifest/root-delta parity with the cloud path, then `toMachinePath` re-anchors that virtual frame onto the chosen host path. An empty/NULL `workingDir` (the default) is a byte-identical no-op that resolves to the agent's launch workspace root.

Targeting a machine at session creation uses `CreateSessionRequest.targetSandboxId` (the enrolled machine's sandbox id) plus optional `workingDir` (validated in `apps/api/src/domain/sessions.ts`); `workingDir` supplied without `targetSandboxId` is a 422. The dashboard/enrollment surfaces are `apps/api/src/routes/machines.ts` and `enrollments.ts` over `apps/api/src/sandbox/{machines,enrollment}.ts`, and the opt-in UI lives at the `@opengeni/react/machines` subpath (the package root stays a clean sandbox-only default).

## Workspace And Resources

Find the current workspace root in runtime manifest code and in the per-backend `CAPABILITY_DESCRIPTORS` rows. `/workspace` is the default for the container/cloud backends, but it is NOT universal: some backends declare a different root (e.g. e2b `/home/user`, vercel `/vercel/sandbox`), and a Connected Machine (`selfhosted`) runs at a per-session `workingDir` re-anchored onto the machine's real launch directory rather than a fixed `/workspace` (see the Connected Machine section above).

Common resource behavior:

- Repository resources become git repo manifest entries, commonly under `repos/<owner>/<repo>`.
- File resources become object-storage-backed mounts, commonly under `files/<file-id>`.
- Uploaded files are read-only. Agents should copy them before modifying.
- Bundled infrastructure skills may be made available under `.agents/` through the Agents SDK skills capability.
- Enabled capability packs may add skills to the same `.agents/` skill index and may declare a `sandboxImage` that overrides `OPENGENI_DOCKER_IMAGE`/`OPENGENI_MODAL_IMAGE_REF` for the workspace's sessions (one image-declaring pack per workspace; see `docs/packs.md`).

Always trace resource flow end to end:

1. API validates `ResourceRef`.
2. Session/turn/scheduled task stores resources.
3. Worker merges session and turn resources.
4. Runtime builds the manifest.
5. SDK sandbox materializes the manifest.
6. Prompt text tells the agent where attached files are visible.

## Object Storage For File Mounts

OpenGeni uses object storage for uploaded bytes. The API and browser use the host-visible endpoint. Sandboxes often need a different endpoint because `127.0.0.1` inside a container points at the container, not the host. Local/self-contained modes usually use `s3-compatible` MinIO. Production modes should use `azure-blob`, `aws-s3`, or `gcs`.

Typical local shape:

```bash
OPENGENI_OBJECT_STORAGE_ENDPOINT=http://127.0.0.1:9000
OPENGENI_OBJECT_STORAGE_SANDBOX_ENDPOINT=http://host.docker.internal:9000
OPENGENI_OBJECT_STORAGE_BUCKET=opengeni-files
OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID=...
OPENGENI_OBJECT_STORAGE_SECRET_ACCESS_KEY=...
```

When debugging file mounts, verify:

- Object storage is configured and reachable by API.
- Upload was completed and file status is ready.
- For `s3-compatible`, the sandbox endpoint is reachable from the sandbox backend.
- For `azure-blob`, Docker/local sandboxes can use Azure Blob manifest mounts; Modal uses signed download materialization.
- For `aws-s3` and `gcs`, file resources use short-lived signed download materialization instead of assuming static storage keys in the sandbox.
- Bucket, prefix, credentials, region/provider, path-style settings match current runtime code.
- The resource mount path is valid and does not conflict with another resource.

## Sandbox Preparation Profiles

Sandbox secrets are explicit. Do not assume model provider credentials or host env automatically enter the sandbox.

Current config pattern:

- `OPENGENI_SANDBOX_PREPARATION_PROFILES` selects local preparation profiles such as `none`, `azure`, or `github`.
- `OPENGENI_SANDBOX_ENV_ALLOWLIST` adds specific host env var names to expose to the sandbox.
- A preparation profile can allow env vars and can enable sandbox lifecycle hooks such as Azure CLI login.

Current guidance:

- Prefer short-lived credentials.
- Pass only what the sandboxed agent needs.
- Keep model provider credentials out of the sandbox unless a tool in the sandbox truly needs them.
- Treat sandbox preparation as operator-controlled policy, not automatic behavior.

## GitHub Credentials

There are two GitHub credential paths:

1. The `github` sandbox preparation profile may copy existing local `GH_TOKEN`/`GITHUB_TOKEN` and raw host git identity vars.
2. GitHub App repository resources can cause the worker to mint short-lived installation tokens scoped to selected repositories. For repository resources that need the clone-hook path, OpenGeni keeps GitHub credentials out of the persisted sandbox manifest and runs a sandbox lifecycle hook that clones the selected repositories inside the sandbox before the agent starts. It may also inject git/gh-compatible env/config for that run when the sandbox itself needs to use GitHub. This entire GitHub-App path is SKIPPED when the turn's effective backend is a Connected Machine (`selfhosted`): `sandboxEnvironmentForRun` runs with `skipGitHubToken` (no installation token is minted, no git auth env is injected) and `repositoryUsesSandboxClone` returns false (no clone hook). The machine uses its own git credentials and already holds its own checkout — the platform must not clone onto or authenticate on the user's real disk (see the Connected Machine section).

Explicit `OPENGENI_GIT_*` settings can set sandbox git author/committer identity independently of ambient host env. Raw host `GIT_AUTHOR_*` and `GIT_COMMITTER_*` values should only enter through the `github` preparation profile or `OPENGENI_SANDBOX_ENV_ALLOWLIST`.

When documenting GitHub access, distinguish:

- GitHub App setup/listing/token minting in the API/packages.
- Repository resource selection by session/turn/scheduled task.
- Sandbox-side repository clone lifecycle hooks and Git config/askpass env injected into the sandbox.
- Actual commits/branches/PRs performed by agent tools inside the sandbox, not by a first-class OpenGeni PR API unless current code adds one.

## Azure And Cloud Credentials

Current Azure behavior is service-principal oriented. If the `azure` preparation profile is enabled and ARM/AZURE service principal variables are allowed into the sandbox, the worker/runtime can run a `beforeAgentStart` sandbox lifecycle hook that pre-authenticates normal Azure CLI inside the sandbox with `az login --service-principal`.

Important wording:

- Say "pre-authenticates Azure CLI when the `azure` preparation profile is enabled and service-principal vars are present."
- Do not say there is a custom OpenGeni Azure login helper.
- Do not imply all cloud providers have equivalent lifecycle hooks unless current code shows it.

## Ports And Network Policy

There may be backend-specific exposed port configuration. Current Docker/Modal setup has an exposed ports config path; verify exact behavior in runtime code.

Be conservative about network claims:

- Exposed ports are not the same as a network security policy.
- Do not claim egress allowlists, VPC controls, or policy enforcement unless current code/backend docs prove they are wired.
- If a backend has its own network controls, label them as backend-provided and confirm OpenGeni exposes/configures them before claiming product support.

## Adding A New Sandbox Backend

The durable integration work is larger than adding an enum. Checklist:

1. Add/adjust backend name in contracts and client-facing types.
2. Add config schema, env parsing, validation, and `.env.example` docs.
3. Implement or import an OpenAI Agents SDK-compatible `SandboxClient`.
4. Wire backend selection in runtime sandbox client creation.
5. Confirm manifest entries for repos/files/skills work with the backend.
6. Support session state serialization/deserialization and backend id checks if resume matters.
7. Support `applyManifest`/`materializeEntry` or document limits for adding resources across turns.
8. Decide how env vars and secrets enter the backend.
9. Decide whether Azure/cloud lifecycle hook command execution works.
10. Add unit/integration/e2e tests for create, run, file mount, repo mount, resume, and failure paths.

## Claims To Avoid Unless Re-Verified

- "All sandboxes support the same mounts, ports, resume, and network behavior."
- "Model provider credentials are automatically available inside the sandbox."
- "OpenGeni enforces sandbox egress/network policy."
- "Uploaded files can always be mounted mid-session."
- "The sandbox writes result artifacts back automatically."
- "Local mode is secure isolation."
- "GitHub PR creation is an OpenGeni API feature."
- "A specific tool exists in the sandbox image" without checking the current Dockerfile or image.
