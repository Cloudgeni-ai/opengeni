# Security Policy

## Reporting Vulnerabilities

Please report security issues through GitHub private vulnerability reporting for this repository instead of opening a public issue.

Include:

- Affected component or endpoint.
- Steps to reproduce.
- Expected and observed impact.
- Any relevant logs with secrets removed.

## Sensitive Data

Do not include API keys, tokens, private keys, cloud credentials, customer data, or production infrastructure details in issues, pull requests, logs, screenshots, or test fixtures.

## Local Development

OpenGeni runs agents that can execute tools in configured sandboxes. Review `.env` carefully before running live sessions, especially sandbox preparation profiles and `OPENGENI_SANDBOX_ENV_ALLOWLIST`. These preparation and env-injection controls describe what reaches a **managed sandbox** — a box OpenGeni provisions. A [Connected Machine](#connected-machines) is a different trust boundary; see below.

The base API is workspace-scoped and resolves protected requests through an access grant. `managed` mode uses Better Auth for browser human auth and OpenGeni-owned API keys for product/API access. `configured` mode lets a self-hosted or embedded deployment use delegated bearer tokens or a deployment shared-key boundary. The deployment shared key uses `x-opengeni-access-key`; product API keys use `Authorization: Bearer`.

Before exposing OpenGeni beyond local development, choose the access mode intentionally, run the workspace-isolation/RLS checks, use a non-owner application DB role in production where possible, and put appropriate gateway rate limits and request size limits in front of public routes.

No model provider credentials are automatically exposed inside agent sandboxes. Only expose host credentials to a managed sandbox through explicit preparation profiles or allowlists, and prefer short-lived credentials.

Codex rate-limit reset credits are an irreversible owning-human browser
capability, not agent capacity. The consume route is available only in managed
mode and requires a direct Better Auth cookie session, the same `user:<id>` that
most recently connected the credential, workspace admin, exact same-origin
`Origin`/Fetch Metadata, and a session-bound HMAC confirmation. It rejects every
`Authorization` header even when a valid cookie is also present. There is no SDK,
MCP, Toolspace, worker, scheduled, background, allocator, or rotation consume
path; provider bearer values remain server-only.

## Connected Machines

A Connected Machine is a computer a user enrolls and runs sessions on directly — a first-class, co-equal compute target alongside the managed sandbox. Because a machine session runs on hardware OpenGeni does not own, its trust boundary differs from a managed sandbox in specific, deliberate ways.

**The feature is off by default.** It is gated by `OPENGENI_SANDBOX_SELFHOSTED_ENABLED`; while off, the enrollment and machine routes return `404` and the machine backend is inert, so no deployment exposes this surface without an operator deliberately enabling it.

**No OpenGeni-minted token is distributed to the machine.** For a managed sandbox, OpenGeni mints a short-lived, run-scoped GitHub App installation token and injects it (plus git identity and any workspace-environment values) into the box. A machine-targeted turn skips that mint entirely: the machine uses its **own** local git credentials. The agent's command RPC to the machine carries an empty environment on the wire — the run's env block is used only for an internal manifest-parity check in the worker and is never transmitted to the machine. In practice, the workspace-environment / allowlist / preparation-profile injection that reaches a managed sandbox does **not** push secrets into a machine's commands.

**What that means for the operator's own machine.** Running on your own hardware means the agent operates with whatever that machine's environment already holds — its logged-in git credentials, its shell environment, its files. That access is the point, and it is also the risk: enroll a machine only where you accept an agent acting with that machine's own credentials and reachable data. OpenGeni does not clone selected repositories onto the machine's real disk; the machine already owns its filesystem, and the agent works in the per-session working folder chosen at session creation.

**Enrollment and consent.** A machine joins a workspace one of two ways, both requiring the `enrollments:manage` permission on the approving side:

- **Device flow (explicit consent):** the machine's agent starts an enrollment (unauthenticated, presenting only the deployment access key, IP-rate-limited) and prints a short user code. A workspace member with `enrollments:manage` then approves that specific code. Approval is the loud consent step and records who approved. An unauthenticated start can never grant access to a workspace no authorized user later approves in — the approve is workspace-scoped to the code.
- **Zero-click enroll token:** a member with `enrollments:manage` mints a short-TTL enroll token; the agent redeems it headlessly (the token is the grant). This is for scripted or fleet enrollment and carries the same authorization the human approve would.

Screen control is a separate opt-in granted at approval, not implied by enrollment. Machines can be listed and revoked at any time (`enrollments:read` / `enrollments:manage`).

**Relay isolation.** A machine's agent dials **out** to the control plane; nothing routes inbound to the machine. Terminal and desktop frames flow through a separate stream relay that pairs an agent (producer) with a viewer (consumer) by channel key. The relay is a byte-pump with bounded buffers and per-token rate limits: the agent authenticates to it with a signed, short-lived producer token, and a viewer with its own token, so the relay never grants ambient access to a machine.

Operators enabling this feature must provision the relay and the enrollment/relay signing secrets and keep rate limits on the enrollment routes. See the README's Connected Machines section for the provider-neutral deployment shape.
