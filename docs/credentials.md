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
| Machine enrollment bearer | `oge_…` | Enrollment flow (click-Grant or device flow) | HMAC + active enrollment row + exact credential generation | 30 days; generation-rotated on every re-enrollment | A self-hosted/connected machine agent |
| Headless enrollment token | `oget_…` | Operator via enrollment API | HMAC + embedded workspace/account/consent/expiry | Multi-use within its one-hour TTL | Fleet provisioning scripts for headless machines; passed to the agent through `OPENGENI_ENROLL_TOKEN`, never installer argv |
| Relay producer token | `ogr_…` | API for self-hosted relay producers | HMAC | Short | The relay forwarding desktop frames |
| NATS user JWT / callout | NATS credentials | API auth-callout service | NATS server (callout account) | At most 5 minutes, capped by the enrollment bearer's remaining life | Machine agents and internal services on the message bus |
| Session MCP headers | Arbitrary headers, encrypted at rest | Embedding host per session (`mcpServers` on create; rotatable per user turn) | Never read back — write-only, decrypted only in the worker | Host-defined; version-bumped on rotation | Host's own MCP server called from a session |
| Capability MCP headers | Arbitrary headers, encrypted at rest | Workspace admin when configuring a capability | Write-only, worker-side decrypt | Until reconfigured | Third-party MCP servers enabled workspace-wide |
| Codex subscription tokens | ChatGPT access/refresh/id tokens, encrypted | Device-code login flow | OpenAI; OpenGeni stores encrypted, never returns them | Provider-defined, auto-refreshed | Workspaces using a ChatGPT/Codex subscription as a model provider |
| Git provider token | GitHub App / GitLab / Azure DevOps token | OpenGeni or embedding host per provider | Git provider | Provider-defined, proactively renewed during active managed-sandbox turns | Sandbox git operations and provider CLIs (delivered via token files + askpass/CLI wrappers, never baked into manifests) |
| Signed storage URLs | Time-limited URL | API via object storage | Storage provider | Minutes | File upload/download without exposing storage credentials |

Rules that hold across the table:

- **Secrets are write-only.** Anything a caller supplies (MCP headers, Codex
  tokens) is encrypted at rest and never echoed by any read endpoint — responses
  expose header *names* and credential *versions* only.
- **Rotation over longevity.** Rotating credentials are never stored in
  long-lived artifacts such as sandbox manifests. Git provider tokens are
  delivered at setup and proactively re-minted by the worker throughout an
  active managed-sandbox turn; session MCP bearers are re-delivered per turn.
- **Sandbox git auth is pointer-based.** The manifest carries stable paths such
  as `OPENGENI_GIT_CREDENTIALS_DIR` and `OPENGENI_GIT_TOKEN_FILE`, while the
  worker/runtime seed current token values into files inside the sandbox.
  `GIT_ASKPASS` reads those files for git, and the `gh`, `glab`, and `az`
  wrappers read them at invocation time before setting child-process-only token
  env vars. Renewal atomically replaces the same files, so multi-day turns see
  current credentials without model action or manifest mutation. Setup on a
  managed box is ordered as rig setup → deployment/rig credential hooks →
  Toolspace token → Git binding/mint/install → repository clone. The Git step
  receives the established real session, so lazy materialization resumes the
  box before discovery or mint and credentials are installed before clone. A
  token file is never authorization: explicit GitHub metadata must identify a
  standard HTTPS or SSH `github.com` endpoint, while a
  resource-less/rematerialized box requires every
  discovered repository root to produce one sanitized supported origin and
  binds the complete set to exact workspace-authorized catalog/host refs. Every
  install, refresh, expiry unlink, and controller deactivation checks the full
  active binding-generation set under row locks; one concurrent rebind fences
  the whole stale mutation. Multi-provider token bundles must be complete.
  Failed install/refresh scripts remove every selected final and PID-temporary
  token file, and lifecycle failures surface fixed typed codes rather than raw
  provider/sandbox errors. Revocation, an unprovable refresh, or exact token
  expiry unlinks the provider file. Missing token files are clean passthroughs.
- **The perimeter is not identity.** The deployment access key gates who can
  talk to a deployment at all; workspace identity and permissions always come
  from one of the identity-bearing credentials above it.
- **Machine revocation is bounded, not a claimed synchronous disconnect.** A DB
  revoke immediately denies the next NATS authorization/reconnect. A connection
  that already holds a callout-minted user JWT may remain live until that JWT
  expires; the control plane caps that residual interval at five minutes. A
  re-enrollment atomically advances the row's credential generation, so the old
  `oge_` bearer can neither authenticate nor self-revoke the new generation.
