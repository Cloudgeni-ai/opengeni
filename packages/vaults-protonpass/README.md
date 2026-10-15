# `@opengeni/vaults-protonpass`

The Proton Pass provider for Opengeni vaults. It implements `VaultProvider`
from `@opengeni/vaults` by running the official Proton Pass CLI
([`pass-cli`](https://protonpass.github.io/pass-cli/)) 2.4.2 under a
personal access token (PAT) that the customer scopes to vaults or items.

Load it only with a dynamic `import()` from the API or the worker
(`test/import-guard.test.ts`).

## The CLI is operator-installed

This package does not download, bundle or redistribute `pass-cli`. The
operator installs it on the API and worker hosts and points the adapter at it.
Before each session the adapter checks that:

- the binary is an absolute path (or `pass-cli` found on a fixed
  `/usr/bin:/bin` PATH) and is not world-writable;
- `pass-cli --version` reports exactly `PROTON_PASS_CLI_VERSION` (2.4.2), or
  `expectedVersion`;
- its SHA-256 matches `expectedSha256`, when given.

## Usage

```ts
const { createProtonPassVaultProvider } = await import("@opengeni/vaults-protonpass");
const provider = createProtonPassVaultProvider({
  token, // "pst_…::…", decrypted from the connection's stored credential
  binaryPath: "/opt/proton/pass-cli",
  stateRoot: "/var/lib/opengeni/protonpass", // optional; default <tmpdir>/opengeni-protonpass
});
// … use it, then
await provider.close(); // logs out and wipes the session directory
```

Other options: `expectedVersion`, `expectedSha256`, `commandTimeoutMs`
(default 60 s), `maxStdoutBytes` (32 MB), `sessionMaxAgeMs` (105 minutes),
`idleCloseMs` (15 minutes), `valueCacheMs` and `maxItemViewsPerList` (500).
`operations` narrows the provider to the operations verified at setup and
refuses the rest without running the CLI. `runner`, `hostEnv` and `now` exist
for tests.

Servers use `createProtonPassProviderPool({ binaryPath, … })` once per
process. `pool.provider(token, { connectionId?, operations? })` returns a
provider whose session is created on its first call. Sessions are scoped to
the connection id and token: one connection reuses its logged-in CLI session,
while different connections (even with the same token) and different tokens
never share a session, state directory, key or cache. Without a connection id
the provider gets a session of its own. A connection's new token replaces its
idle old session. Sessions unused for 15 minutes (`poolIdleMs`) are logged
out, wiped and forgotten. `maxSessions` (32) is a hard limit: the least
recently used idle session makes room, and when every session is busy the
call fails with `provider_rate_limited` (retry after
`PROTON_PASS_POOL_BUSY_RETRY_MS`, 5 seconds). `pool.close()` logs them all
out and refuses later calls.

## How it runs the CLI

- **No shell, bounded output.** Every command is spawned with an argument
  list, a deadline, bounded stdout and stderr, and a process-group kill. At
  most `PROTON_PASS_MAX_PROCESSES` (4) CLI processes run at once per process,
  and commands for one connection are serialized. A finished process hands
  its slot straight to the next waiting command, so the limit holds under
  contention.
- **Secrets never go on argv.** The PAT is passed only in the environment of
  `pass-cli login`. Item values for create go in on stdin
  (`item create … --from-template -`).
- **Private, isolated state.** Each provider has its own `0700` state
  directory (used as `HOME` and `PROTON_PASS_SESSION_DIR`), the `env` key
  provider with a random per-instance `PROTON_PASS_ENCRYPTION_KEY`, telemetry
  and update checks off, and a minimal environment (only proxy and CA
  settings pass through). The directory is removed on `close()`, idle close
  and process exit.
- **Session lifecycle.** PAT sessions last about two hours, so the adapter
  logs in again after 105 minutes. A "requires an authenticated client" reply
  re-logs in and retries once. An invalidated session re-logs in and retries
  reads only; a write whose outcome is unknown is never retried.
- **Agent tokens.** For an agent PAT the CLI requires a reason on every
  command; the adapter sends a short one built from the action and, when the
  caller supplies it, the requesting authority. Agent tokens cannot list
  item values in bulk, so listing views each item (at most 500 per list, else
  `provider_inventory_incomplete`); each view is an audit event in Proton.
  Bulk listings view only this share's items that have files, under the same
  bound.
- **Errors.** Failures map to `VaultProviderError` codes from the CLI's
  `Reason:` lines and HTTP status. Raw stderr is never surfaced. A failed
  write is definite only when the server's verdict is tied to that write;
  otherwise it is `provider_outcome_unknown`. A failed login is
  `provider_auth_invalid` only when Proton refused the token (400, 401, 403
  or 422, or a permission or not-found reason, in the token-login context);
  local, network, server and unrecognised failures are
  `provider_unavailable` (429 is `provider_rate_limited`).

## What it can do

`PROTON_PASS_OPERATIONS` declares exactly this:

| Operation | Supported | Notes |
| --- | --- | --- |
| List vaults | yes | `share list --only-vaults`; write access from the share role. Falls back to `vault list` (access unknown) when shares cannot be listed. |
| List items, read values | yes | Values read live, cached per attempt; `forceRefresh` bypasses the cache. |
| Read files | yes | Downloaded to a private directory, at most 256 KiB. |
| Create | login, note, custom (`api_key`) | Including a TOTP seed on logins. A login takes only fields named `username`, `email` and `password` plus one TOTP; any other field is refused before running anything (use an `api_key` item). |
| Update | **no** | The CLI's update takes values only as `--field` arguments and cannot change TOTP or time fields, so updates would put secrets on argv. Reported as `provider_unavailable` without running anything. |
| Archive | trash (recoverable) | `item trash`. Permanent delete and restore are not exposed. |
| Create vault, write files | no | |

Writes to a share whose role is read-only are refused locally; Proton
enforces the rest.

The per-attempt value cache belongs to one provider instance (one token and
session), so providers that share an attempt budget never see each other's
values. Items with more than 50 fields or 20 websites (or a website over
2,048 characters) make the listing `provider_inventory_incomplete` instead of
being mirrored cut down.

Field ids: `@note`, `login.username`, `login.email`, `login.password`,
`login.totp`, `x:<name>` (extra fields), `s:<section>/<field>` (custom item
sections), `ssh.*`, `wifi.*`, `card.*`, `identity.*` and `@file:<id>`, with
`#n` on repeated names.

## Testing

`bun test` runs against `test/fake-pass-cli.ts`, a fake CLI that follows the
2.4.2 source's arguments, JSON output and error lines. It covers the shared
provider contract (read side), session lifecycle, agent reasons, error
mapping, timeouts, output bounds, permissions and isolation.

No live Proton account was used: the output shapes and error lines come from
the CLI source and documentation, not from a live run.
