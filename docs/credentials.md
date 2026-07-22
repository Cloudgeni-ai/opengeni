# Credential taxonomy

Audience: integrators and operators. One page for every credential the system
mints or accepts — what it is, who issues it, where it travels, and who may see
it. If you are deciding *which* credential to use: API clients use an **API
key**; hosts acting on behalf of their own users use a **delegated token**;
everything else is machinery you receive from OpenGeni rather than choose.

| Credential | Prefix / transport | Issued by | Verified by | Lifetime | Intended holder |
| --- | --- | --- | --- | --- | --- |
| Deployment access key | `x-opengeni-access-key` header | Operator (env) | API perimeter middleware | Static | Every caller of a key-gated deployment (coarse perimeter, not identity) |
| Product API key | `ogk_…` bearer | Workspace member via `POST /v1/workspaces/:id/api-keys` | Hash lookup (stored hashed, shown once) | Until revoked | A product/backend calling the REST API for one workspace |
| Delegated access token | `ogd_…` bearer | Host with the deployment's delegation secret (HMAC) | HMAC + embedded workspace/account/permissions | Short (embedded expiry) | An embedding host acting as one of its users; also self-minted internally for first-party MCP |
| Managed web session | Better Auth cookie | Managed auth (email/password) | Better Auth session lookup | Session | Humans in the hosted web console |
| Stream token | `ogs_…` (query/header) | API, on viewer/stream mint | HMAC, scope+TTL embedded | Minutes | Browsers attaching to desktop/terminal streams |
| Machine enrollment bearer | `oge_…` | Enrollment flow (click-Grant or device flow) | Stored credential + NATS auth-callout | Until revoked | A self-hosted/connected machine agent |
| Headless enrollment token | `oget_…` | Operator via enrollment API | One-time exchange for `oge_…` | Single use | Provisioning scripts for headless machines |
| Relay producer token | `ogr_…` | API for self-hosted relay producers | HMAC | Short | The relay forwarding desktop frames |
| NATS user JWT / callout | NATS credentials | API auth-callout service | NATS server (callout account) | Connection | Machine agents and internal services on the message bus |
| Session MCP headers | Arbitrary headers, encrypted at rest | Embedding host per session (`mcpServers` on create; rotatable per user turn) | Never read back — write-only, decrypted only in the worker | Host-defined; version-bumped on rotation | Host's own MCP server called from a session |
| Capability MCP headers | Arbitrary headers, encrypted at rest | Workspace admin when configuring a capability | Write-only, worker-side decrypt | Until reconfigured | Third-party MCP servers enabled workspace-wide |
| Codex subscription tokens | ChatGPT access/refresh/id tokens, encrypted | Device-code login flow | OpenAI; OpenGeni stores encrypted, never returns them | Provider-defined, auto-refreshed | Workspaces using a ChatGPT/Codex subscription as a model provider |
| Git credential-binding token | GitHub App / GitLab / Azure DevOps token | OpenGeni or embedding host per repository binding | Git provider | Provider-defined, independently renewed during active managed-sandbox turns | Sandbox git operations and provider CLIs (delivered via hashed binding token files + path-aware helper/CLI wrappers, never baked into manifests) |
| Signed storage URLs | Time-limited URL | API via object storage | Storage provider | Minutes | File upload/download without exposing storage credentials |

Rules that hold across the table:

- **Secrets are write-only.** Anything a caller supplies (MCP headers, Codex
  tokens) is encrypted at rest and never echoed by any read endpoint — responses
  expose header *names* and credential *versions* only.
- **Rotation over longevity.** Rotating credentials are never stored in
  long-lived artifacts such as sandbox manifests. Git provider tokens are
  delivered at setup and proactively re-minted by the worker throughout an
  active managed-sandbox turn; session MCP bearers are re-delivered per turn.
- **Sandbox git auth is pointer-based and binding-scoped.** The manifest carries stable paths such
  as `OPENGENI_GIT_CREDENTIALS_DIR` and `OPENGENI_GIT_TOKEN_FILE`, while the
  worker/runtime seed current token values into files inside the sandbox.
  Binding ids are SHA-256-derived before entering filenames. Git selects by
  protocol + host + path; `gh`, `glab`, and `az` select by an explicit binding,
  current `origin`, or an unambiguous sole binding. Provider aliases exist only
  for a single binding. Renewal atomically replaces each binding file, so a
  multi-day turn sees current credentials without model action or manifest
  mutation and a failed sibling refresh cannot overwrite it.
- **The perimeter is not identity.** The deployment access key gates who can
  talk to a deployment at all; workspace identity and permissions always come
  from one of the identity-bearing credentials above it.
