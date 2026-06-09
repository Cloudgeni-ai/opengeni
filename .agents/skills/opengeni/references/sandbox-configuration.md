# Sandbox Configuration Reference

Use this as a checklist, not as a substitute for reading current code. Re-check source before making exact claims because backend names, env vars, and runtime behavior can change.

## Fast Discovery

Start with these searches:

```bash
rg -n "SandboxBackend|sandboxBackend|OPENGENI_SANDBOX|DockerSandboxClient|ModalSandboxClient|UnixLocalSandboxClient|createSandboxClient|buildManifest|s3Mount|gitRepo|collectSandboxEnvironment|sandboxEnvironmentForRun|azureCliLogin|withSandboxLifecycleHooks|GIT_ASKPASS|OPENGENI_OBJECT_STORAGE_SANDBOX_ENDPOINT" \
  packages apps docker .env.example README.md AGENTS.md
```

Then inspect:

- Contracts: `packages/contracts/src/index.ts` for allowed backend names and resource shapes.
- Config: `packages/config/src/index.ts` and `.env.example` for env var parsing/defaults/validation.
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

Find the current backend enum in contracts. The current architecture supports a small set of configured backends and treats the backend implementation as an OpenAI Agents SDK sandbox client.

Typical meanings:

- **Docker**: local container sandbox. Requires building or providing a sandbox image.
- **Modal**: remote Modal sandbox backend through the Agents SDK extension.
- **Local**: Unix local sandbox client, useful for development but weaker isolation.
- **None**: no sandbox client; the agent runs without sandbox capabilities.

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

## Workspace And Resources

Find the current workspace root in runtime manifest code. The current design uses `/workspace` for sandboxed runs.

Common resource behavior:

- Repository resources become git repo manifest entries, commonly under `repos/<owner>/<repo>`.
- File resources become object-storage-backed mounts, commonly under `files/<file-id>`.
- Uploaded files are read-only. Agents should copy them before modifying.
- Bundled infrastructure skills may be made available under `.agents/` through the Agents SDK skills capability.

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
2. GitHub App repository resources can cause the worker to mint short-lived installation tokens scoped to selected repositories. For repository resources that need the clone-hook path, OpenGeni keeps GitHub credentials out of the persisted sandbox manifest and runs a sandbox lifecycle hook that clones the selected repositories inside the sandbox before the agent starts. It may also inject git/gh-compatible env/config for that run when the sandbox itself needs to use GitHub.

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
