# Secrets: vaults, references and delivery

Secrets replace Variable Sets. People and agents keep passwords, API keys,
one-time-code seeds, passkeys, notes and files in **vaults**, and agents use
them through `{{secret:…}}` **references**. A reference is resolved only at the
moment a tool executes. The plaintext never enters the model context, events,
journals, approvals, logs or stored tool arguments.

This page owns the model. Other docs link here instead of restating it.

## Model

A **vault** holds a flat list of **items**. An item holds named **fields**, and
each hosted field keeps encrypted **versions**.

| Concept | Values |
|---|---|
| Vault owner kind | `user` (shown as **Only me**), `workspace`, `organization`, `task` |
| Vault source | `opengeni` (hosted), `onepassword`, `host` (embedder provider) |
| Vault mode | `read_write`, `read_only` (hosted vaults are always read-write) |
| Item type | `login`, `api_key`, `note`, `file`, `passkey` |
| Field kind | `text`, `concealed`, `totp`, `file` |

- **Only me** vaults belong to one organization member and are usable in every
  workspace of that organization they can access. No admin can list or read
  another person's Only me vault.
- **Workspace** vaults are usable by members of that workspace.
- **Organization** vaults are managed with `account:admin`; their reach is set
  by "Available in" (all workspaces or a list, and optionally personal
  workspaces).
- **Task** vaults hold secrets created during one task. There is one per root
  session, and it is deleted with that session.
- Default hosted vaults are created on first use: **Private** (Only me),
  **Shared** (workspace) and **Task**.
- Every value is encrypted with the deployment's environment encryption key,
  including plain text fields. Ten versions are kept per field; older versions
  can be restored. Changing a field's kind needs a new value and starts its
  history over (hiding a text field as concealed keeps it). Deleting an item
  archives it; archived items can be restored and still count toward the
  2,000-item vault limit until they are deleted permanently.
- An Only-me vault lives in its owner's personal workspace when they have one,
  so deleting another workspace does not delete it.
- Items have a **primary field**, used when a reference names no field:
  `password` for logins, `value` for API keys, `note` for notes, `file` for
  files. Passkeys have none.
- Renaming a vault or item keeps the old name as an alias, so existing
  references keep working.
- Limits: 2,000 items per vault, 50 fields per item, 64 KiB per text value,
  256 KiB per file value, names up to 120 characters without `/ { } # \` or
  control characters. A field cannot be named `otp`.

## Who can use what

Agents act under the authority of the human who started the turn (or the
owner of a scheduled task, checked live at every run). The vaults a turn can
resolve are:

- that person's Only me vaults,
- the workspace's vaults,
- organization vaults available in this workspace,
- the root session's task vault.

A turn with no acting human (a service turn) gets the same set without Only me
vaults. A turn whose acting human lacks `secrets:use` (for example a viewer)
reaches only the task vault.

**Policy.** Sessions and scheduled tasks carry an optional vault policy,
`{"mode":"all"}` (the default) or `{"mode":"selected","vaultIds":[…]}`. The
effective set is reach ∩ the session's policy ∩ every ancestor's policy ∩ the
schedule's policy. The task vault is never narrowed. A child session cannot be
given a policy wider than its parent (`vault_policy_outside_parent`, 422), and
a later parent narrowing narrows existing children at the next resolution.
Set it with `PUT /v1/workspaces/:workspaceId/sessions/:sessionId/vault-policy`
or from the session Secrets panel.

**Permissions.**

| Permission | Grants |
|---|---|
| `secrets:list` | See vault and item metadata (names, websites, field names). |
| `secrets:use` | Let agents resolve references under your authority. On by default for members. |
| `secrets:write` | Create, edit, move and archive items in vaults you can reach. |
| `secrets:read` | Reveal plaintext through the API (`reveal`, agent `secret_get`). Humans also need a verified human session; API keys need this literal permission. Copying a value into an item with `fromReference` needs the same reveal authority. |

The old `variable-sets:*` permission names are aliases, so stored roles and API
keys keep working without a rewrite. Viewers can list but not use or reveal.
Every reveal and every resolution batch writes an audit row
(`vault.field.revealed`, `vault.secret.used`); values are never audited.

**Capability.** The `secrets` capability is on by default. When an agent
configuration switches it off, the agent gets no secret tools, prompt block or
skill, secret questions are refused, and references pass through every surface
literally.

## References

```
{{secret:Item}}                    primary field
{{secret:Item/field}}              a named field
{{secret:Vault/Item}}              an item in a named vault
{{secret:Vault/Item/field}}        fully qualified
{{secret:Item/otp}}                current TOTP code of the item's first TOTP field
{{secret:Vault/Item/field/otp}}    code of a named TOTP field
{{secret:Item#previous}}           the version below the current one
{{secret:id:<item-uuid>[/field]}}  by item ID, independent of names
{{secretfile:Item[/field]}}        the value delivered as a 0600 file path
\{{secret:Item}}                   literal text, no resolution
```

- A two-segment reference `A/B` is tried both as item `A` field `B` and as
  vault `A` item `B`; exactly one must match.
- With no vault named, lookup goes tier by tier: task, Only me, workspace,
  organization. The first tier with a match wins; within a tier current names
  beat aliases. Two matches in one tier are `ambiguous`, and the error lists
  ready, fully qualified references to choose from.
- Names match case-insensitively after Unicode NFC normalisation and trimming.
- References are at most 300 characters. Text that starts like a reference but
  does not parse fails the call with `invalid_reference`; it is never passed
  through.
- A tool call resolves all of its references or none. On any failure nothing is
  dispatched and the tool returns a typed error naming the references, never
  values. A missing secret's error includes a ready `request_human_input` call.
- TOTP codes are computed at dispatch and never stored.

The grammar, resolver, splicer, generator and TOTP each have one
implementation: `packages/contracts/src/secret-references.ts`,
`packages/core/src/domain/vaults/`, `packages/vaults/src/splice/`,
`packages/contracts/src/secret-generator.ts`.

## Where references resolve

| Surface | Behaviour |
|---|---|
| `exec_command` (every sandbox backend) | The command is spliced so each reference becomes a shell variable `OPENGENI_SECRET_n`, quoted correctly for its context. Values reach the process through native env where OpenGeni owns the exec, or a 0600 env file that is sourced and deleted in the same command. Commands without references are untouched. |
| Connected machines | POSIX hosts use `/bin/sh`, Windows uses PowerShell; values travel in `ExecRequest.env`. `cmd.exe`, fish and unknown shells return `unsupported_shell`. No run credentials or tokens are copied onto machines. |
| `run_on` | Exec splices for the target's shell; file writes resolve content; reads resolve nothing. |
| `write_stdin`, `apply_patch`, `view_image` | Resolved in the runtime wrapper; stored patches and inputs keep the reference. |
| `{{secretfile:…}}` | Written to a 0600 file under `/tmp/opengeni-private/secrets/` and replaced by its path; removed at attempt end. Use it for binary values and anything over 100 KiB. |
| MCP connectors, Codex apps, Codemode `ogtool` | Arguments are resolved after approval and passed only to the executing call; the journal, approval and receipts keep the reference. `secretfile` is not allowed here. |
| Opengeni's own tools (messages, sessions, schedules, goals, Knowledge, artifacts, admin actions) | Resolved like connectors: the executing call receives values, while the journal keeps the reference. To store or hand on a reference for later work, escape it (`\{{secret:Item}}`); the tool receives `{{secret:Item}}`. The `secret_*` tools take references as names and never resolve them. |
| Sites | Tool calls from a Site resolve with the viewer's authority (no task vault) and audit the Site. |
| Browser and desktop | `fill`, `type`, clipboard writes and key presses resolve for agent callers. Receipts keep the reference. `type` with `mode: "keys"` handles split one-time-code boxes. Resolved values are never pasted on the desktop. |
| Passkeys | Registering a passkey in the managed browser saves a `passkey` item; later logins use it from the vault and write the sign count back. |

Exec caps: 256 KiB of env per command and 100 KiB per value. Larger or binary
values return `too_large` or `binary_value` with a `secretfile` hint.
OpenSandbox has no file writer, so commands with references fail there with an
unsupported-routing error.

Variable Sets used to inject every value into every sandbox as environment
variables. That is gone: nothing is injected, and a value exists in a process
only while a command that references it runs. Scripts that read ambient
variables should take them from a reference instead, for example
`API_TOKEN={{secret:Stripe}} ./deploy.sh`.

## Asking a person

`request_human_input` supports a `kind: "secret"` question. The card shows a
masked field, an optional username, a password generator when the agent sets
`allowGenerate`, and where the value will be saved (`saveTo`: Only me,
workspace or task). The submitted value is written to a vault in the same
transaction as the answer; the agent receives only the reference, username and
vault name.

- Only hosted vaults can be the target. Saving to Only me needs a signed-in
  human answering.
- Slack, push and email show a link to the card instead of collecting values;
  a value pasted into a Slack thread is never saved as an answer or to a vault,
  though the message itself stays in Slack and in OpenGeni's Slack inbox. Voice
  tells the person to answer in the app.
- `session_human_input_respond` from another agent accepts only a reference or
  a generate request, never a raw value.

## Agent tools

With the `secrets` capability on, agents get:

| Tool | Purpose | Needs |
|---|---|---|
| `secret_search` | Find or list items by name, website, type or vault, with ready references. The first page lists every reachable vault and its item count; `nextCursor` pages through the rest (up to 1,000 items examined per call). | `secrets:list` |
| `secret_save` | Create or update an item; fields take a value, a generated password, another reference or a version to restore. | `secrets:write` |
| `secret_get` | Reveal a value to the model. Agents do not hold `secrets:read` by default. | `secrets:read` |
| `secret_move` | Move or copy an item between vaults. | `secrets:write` |
| `secret_delete` | Archive an item. | `secrets:write` |

The always-on prompt block teaches the reference syntax and the login ladder
(reuse a session, sign in with the saved login and `/otp`, enroll your own 2FA,
read email or SMS codes through connectors, create accounts with generated
passwords when the task allows it, solve CAPTCHAs). Playbooks live in the
bundled `opengeni-secrets` skill.

The retired `variable_set_*` and `environment_*` tools are no longer offered.

## Providers

**1Password.** Install a service-account token with
`POST /v1/workspaces/:workspaceId/connections/1password/install`, then link
vaults with `POST /v1/workspaces/:workspaceId/vaults/link` (read-only or
read-write) or create a managed vault with
`POST /v1/workspaces/:workspaceId/connections/:connectionId/managed-vaults`.

- A connection belongs to one person (Only me), the workspace or the
  organization, and the vaults linked through it carry the same owner. In the
  web app, Settings › Secrets lists each connection under 1Password; its page
  links more vaults, replaces the token and disconnects it.
- `GET /connections/1password/service-accounts` lists the connections the
  caller can see (never their tokens), with `canManage` when the caller could
  have installed them.
- `PUT /connections/:connectionId/1password/token` checks a new token and
  stores it on the same connection, so linked vaults keep their links and sync
  again. A token for a different 1Password account is refused with
  `provider_conflict`.
- `DELETE /connections/:connectionId/1password` unlinks every vault linked
  through the connection, then revokes it. Nothing is deleted in 1Password.
- OpenGeni mirrors item metadata only; values are fetched live and cached per
  attempt for at most 60 seconds, with at most 50 provider reads per attempt.
- Edits in a read-write linked vault are written to 1Password first, then the
  mirror refreshes. A changed item returns `provider_conflict`.
- A per-connection budget follows the plan tier (Family 1,000, Teams 5,000,
  Business 50,000 reads a day). Rate limits set the vault's sync status to
  `rate_limited` with a retry time; expired tokens show `auth_expired`.
- The SDK lives in `packages/vaults-onepassword` and is only loaded by the API
  and worker.
- Not yet supported in linked vaults: `secret_move` into or out of them,
  restoring field history, and file fields.

**Host provider (embedders).** Products that embed OpenGeni can supply a
`vaultProvider` implementing `VaultProvider` from `@opengeni/vaults`; link its
vaults with `provider: "host"`. This replaces the removed `sandboxSecrets` port.
See [embedding.md](embedding.md).

For local development, `OPENGENI_ONEPASSWORD_FAKE_TOKENS=1` enables the
in-memory fake provider tokens `ops_fake_healthy` and `ops_fake_sync_error`.
Managed runtimes refuse to start with it set.

## HTTP API

All routes are under `/v1/workspaces/:workspaceId`.

| Route | Purpose |
|---|---|
| `GET, POST /vaults`; `GET, PATCH, DELETE /vaults/:vaultId` | Vaults |
| `GET, POST /vaults/:vaultId/items`; `GET, PATCH, DELETE /vaults/:vaultId/items/:itemId` | Items |
| `POST /vaults/:vaultId/items/:itemId/restore`, `/move` | Restore an archived item; move or copy |
| `POST …/fields/:fieldId/reveal`; `GET …/fields/:fieldId/versions`; `POST …/fields/:fieldId/restore` | Plaintext, history, version restore |
| `PUT /sessions/:sessionId/vault-policy`; `GET /sessions/:sessionId/secrets` | Session policy and the secrets a session has used |
| `POST /connections/1password/install`; `GET /connections/1password/service-accounts`; `GET /connections/:connectionId/provider-vaults` | 1Password connections |
| `PUT /connections/:connectionId/1password/token`; `DELETE /connections/:connectionId/1password` | Replace a 1Password token; disconnect (unlinks its vaults) |
| `POST /vaults/link`; `POST /vaults/:vaultId/sync` | Provider vaults |

Errors use `{error, message, details?}` with the codes in `VaultErrorCode`
(`packages/contracts/src/vaults.ts`).

## Migrating from Variable Sets

Migration `0739_vaults.sql` (maintenance mode) runs in one transaction:

1. Every active Variable Set becomes a vault with the same ID and owner, and
   every variable becomes an `api_key` item with the same ID and
   byte-identical ciphertext. Names that are not valid vault names are cleaned
   up and keep the old name as an alias, so `{{secret:OLD_NAME}}` still works.
   The copy checks itself and aborts on any mismatch.
2. Protected-fill site authentication is removed (only provider-managed
   site-auth connections remain).
3. Variable values are deleted, and variable names are scrubbed from persisted
   sandbox env in session envelopes and lease resume state.

Set header rows, attachments and the set database routines stay for now,
because scheduled-run admission still fences on them; they are inert. A later
contract migration drops them.

After the migration:

- `/variable-sets/*`, `/environments/*` and `PUT /sessions/:id/variable-sets`
  return 410 `variable_sets_removed`.
- Non-empty `variableSetIds`, `variableSetId`, `environmentId` and rig
  `defaultVariableSetIds` return 422 `variable_sets_removed`. Empty arrays and
  null are accepted and ignored.
- `@opengeni/sdk` 2.0.0 drops the Variable Set methods and types.
- The Variable Sets settings page redirects to Secrets.

Anything that read a set's variables from the environment must now reference
them explicitly.
