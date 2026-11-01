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
| Vault source | `opengeni` (hosted), `onepassword`, `host` (in-process embedder), `external` (remote embedder), `protonpass`, `keeper`, `bitwarden` |
| Vault mode | `read_write`, `read_only` (hosted vaults are always read-write) |
| Item type | `login`, `api_key`, `note`, `card`, `identity`, `ssh_key`, `file`, `passkey` |
| Item category | optional lower-case token such as `database` or `bank_account` ([details](external-vaults.md#item-types)) |
| Field kind | `text`, `concealed`, `totp`, `file` |

- **Only me** vaults belong to one organization member. No admin can list or
  read another person's Only me vault. Their owner sets where each one is
  usable with "Available in": every workspace of the organization they can
  access, or a list of them. Their Personal workspace (the vault's home)
  always has it. A new Only me vault starts in the workspace it was created or
  linked from (only Personal when added from there) unless the request sets
  `availability`; `allowedWorkspaceIds: null` means every workspace. The
  default **Private** vault is always available everywhere. Vaults created
  before this setting existed stay available everywhere until narrowed.
- **Workspace** vaults are usable by members of that workspace.
- **Organization** vaults are managed with `account:admin`; their reach is set
  by "Available in": every shared workspace (`allowedWorkspaceIds: null`) or a
  list of them, and separately whether members' Personal workspaces have it
  (`allowPersonalWorkspaces`). The switch alone decides Personal workspaces,
  whichever workspace choice is made (migration 1171; before it, a vault with
  a list never reached a Personal workspace, so 1171 turned the switch off on
  those vaults to keep their reach).
- **Task** vaults hold secrets created during one task. There is one per root
  session, and it is deleted with that session.
- Default hosted vaults are created on first use: **Private** (Only me),
  **Shared** (workspace) and **Task**.
- Every hosted value is encrypted with the deployment's environment encryption key,
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
  through. Hand-off tools (below) are the exception: they resolve nothing, so
  they keep such text as written.
- A tool call resolves all of its references or none. On any failure nothing is
  dispatched and the tool returns a typed error naming the references, never
  values. A missing secret's error includes a ready `request_human_input` call
  only when the relevant provider inventory could be checked. A provider
  outage or incomplete inventory is not proof that a secret is missing.
- A reference to an item or field marked "ask me each time" that no approval
  covers fails with `approval_required`, and Opengeni itself asks the person
  to allow that use (see [Approval for each use](#approval-for-each-use)).
- TOTP codes are computed at dispatch and never stored.
- An item's main secret has different names in different password managers:
  `password` (logins, Bitwarden), `credential` (1Password API credentials)
  and `value` (Opengeni API keys). A reference naming one of the three that
  finds nothing is looked up again with the other two; if exactly one of
  them resolves, to a concealed field, the reference uses it. So a reference
  to `Payments API/credential` keeps working after the item moves to a
  manager that calls the field `password`. An exact name always wins, an
  item with two of the others resolves neither, and no other field name is
  ever substituted.

The grammar, resolver, splicer, generator and TOTP each have one
implementation: `packages/contracts/src/secret-references.ts`,
`packages/core/src/domain/vaults/`, `packages/vaults/src/splice/`,
`packages/contracts/src/secret-generator.ts`.

## Where references resolve

| Surface | Behaviour |
|---|---|
| `exec_command` (every sandbox backend) | The command is spliced so each reference becomes a shell variable `OPENGENI_SECRET_n`, quoted correctly for its context. Values reach the process through native env where Opengeni owns the exec, or a 0600 env file that is sourced and deleted in the same command. Commands without references are untouched. |
| Connected machines | POSIX hosts use `/bin/sh`, Windows uses PowerShell; values travel in `ExecRequest.env`. `cmd.exe`, fish and unknown shells return `unsupported_shell`. No run credentials or tokens are copied onto machines. |
| `run_on` | The gateway preserves references and escapes for the target delivery boundary. Exec uses the same shell splicing and per-command env/file delivery as `exec_command`, including `secretfile`; file writes resolve content once; reads resolve nothing. |
| Credential profiles | Opt-in variables (for example `GH_TOKEN`) added to the environment of every `exec_command` and `run_on` exec, resolved per command through the same resolver. The command text is unchanged. See [Credential profiles](#credential-profiles). |
| `write_stdin`, `apply_patch`, `view_image` | Resolved in the runtime wrapper; stored patches and inputs keep the reference. |
| `{{secretfile:…}}` | Written to a 0600 file under `/tmp/opengeni-private/secrets/` and replaced by its path; removed at attempt end. Use it for binary values and anything over 100 KiB. |
| MCP connectors, Codex apps, Codemode `ogtool` | Arguments are resolved after approval and passed only to the executing call; the journal, approval and receipts keep the reference. `secretfile` is not allowed in ordinary tool arguments; Opengeni's `run_on` retains its exec delivery boundary through these callers. Inside a shell command, `ogtool call` arguments are command text: escape a reference there (`\{{secret:Item}}`) or the shell resolves it before the tool sees it. |
| Opengeni's hand-off tools: sessions, messages, Steer, goals, schedules, task notes, Knowledge, instructions, Skills, artifacts, Sites data, notifications, and every Opengeni tool not named in the next row | Never resolved. The tool receives the reference text and stores or forwards it; the session, scheduled run or goal continuation that receives it resolves it only when it executes something (a shell command, `run_on`, browser typing, a connector call), under its own vault policy. A missing or malformed reference does not fail the call, and `secretfile` stays text. An escaped reference (`\{{secret:Item}}`) still arrives as `{{secret:Item}}`, so escaping here is optional. Opengeni tools added later are hand-off tools by default. Opengeni's built-in tools that send text to outside systems (Slack bot messages, X, Reddit and social replies, Fiken contacts and invoices, `web_fetch` URLs) are hand-off tools too: the recipient gets the reference text, never the value. |
| Opengeni tools that need a value | Only `excel_run` (runs code in the person's open workbook) and `admin_action_call` when the call fills a request field the action marks as a credential, such as a password manager's API key or an MCP server's headers: only that field resolves, and the rest of the body (a chat's first message, a note) stays reference text. Creating or updating a vault item resolves its body, which the vault keeps. Other `admin_action_call` calls, including actions that return a secret and `tools/invoke`, are hand-off. `event_sources_create_webhook` and `event_sources_update` resolve only `signingSecret`, which the webhook source keeps encrypted; a name or format next to it stays reference text. These resolve like connectors. The `secret_*` tools take references as names and never resolve them. The list and the reason for each entry live in `secretArgumentMode` (`packages/runtime/src/secret-argument-resolution.ts`). |
| Sites | Tool calls from a Site resolve with the viewer's authority (no task vault) and audit the Site. Hand-off tools keep reference text for Sites too. |
| Browser and desktop | `fill`, `type`, clipboard writes and key presses resolve for agent callers. Receipts keep the reference. `type` with `mode: "keys"` handles split one-time-code boxes. Resolved values are never pasted on the desktop. |
| Passkeys | Registering a passkey in the managed browser saves a `passkey` item; later logins use it from the vault and write the sign count back. A login in a connected password manager that holds a passkey (Bitwarden, Vaultwarden, Keeper, Proton Pass) shows `hasPasskey`, matches a `passkey` search and signs in the same way; its key is read live from the provider and never stored. See [external vaults](external-vaults.md). |

Exec caps: 256 KiB of env per command and 100 KiB per value. Larger or binary
values return `too_large` or `binary_value` with a `secretfile` hint.
OpenSandbox has no file writer, so commands with references fail there with an
unsupported-routing error.

Hand-off tools exist because an agent once wrote an unescaped reference into
`session_create` (26 October 2026): the tool received the value and stored it
in the child's first message, while the caller's own journal kept only the
reference. Now a reference reaches another session, a schedule, a goal, a note,
Knowledge or an artifact only as text, and a backslash escape is no longer
needed to keep it that way. The receiving work resolves it with its own
principal and vault policy: a child's policy is never wider than its parent's
(the effective set is intersected with every ancestor at each resolution), and
a scheduled run uses the schedule's owner and policy. A message or Steer sent
into a turn that another person started resolves later under that turn's
person, exactly as if it had been typed in that chat. Inside a shell command or
a script, including `ogtool call`, the escape is still needed: the command or
file write puts the value in before any tool runs. With the `secrets`
capability off for an agent, nothing resolves in that agent's tool calls and
text passes unchanged, backslash included. A tool call nested in
`admin_action_call` (`tools/invoke`, `tools/calls`) is resolved by the app
under the person's own access, not the session's task vault or vault policy;
it needs full access, which already acts as the person.

Stored content is otherwise kept exact. The 5 August 2026 decision against
heuristic redaction still holds, with two approved exceptions: known secret
values are masked ([Masking](#masking)), and so are narrow, high-precision
secret-shaped strings in tool output
([Secret-shaped values in tool output](#secret-shaped-values-in-tool-output));
see [Masking decision](#masking-decision).

For `run_on`, resolution is scoped to exec `op.cmd` and write `op.content`;
`target`, `op.path` and `op.workdir` are literal routing/path inputs. Secret
failures dispatch no command or file write and return the gateway's canonical
`isError` tool result containing only the serialized secret failure, including
a missing-secret `askCard` or per-use `approvalCard`. No ordinary `run_on`
result fields are added to that failure. Approval cards describe the actual
target command or file write rather than a generic connector call.

Variable Sets used to inject every value into every sandbox as environment
variables. That is gone: nothing is injected, and a value exists in a process
only while a command that references it runs. Scripts that read ambient
variables should take them from a reference instead, for example
`API_TOKEN={{secret:Stripe}} ./deploy.sh`, or from a credential profile when
every command should have the variable.

## Credential profiles

A credential profile is an opt-in list of environment variable names, each
mapped to one secret reference. Opengeni adds those variables to the
environment of every command an agent runs, so CLIs such as `gh`, `az` or
`terraform` find their credentials without the agent writing references into
each command or into the prompts of the chats it starts.

```json
{
  "entries": [
    { "name": "GH_TOKEN", "reference": "{{secret:cloudgeni-cloud-auth/CLOUDGENI_GITHUB_TOKEN/value}}" },
    { "name": "AZURE_CLIENT_ID", "reference": "{{secret:cloudgeni-cloud-auth/AZURE_CLIENT_ID/value}}" },
    { "name": "AZURE_CLIENT_SECRET", "reference": "{{secret:cloudgeni-cloud-auth/AZURE_CLIENT_SECRET/value}}" },
    { "name": "AZURE_TENANT_ID", "reference": "{{secret:cloudgeni-cloud-auth/AZURE_TENANT_ID/value}}" },
    { "name": "AZURE_SUBSCRIPTION_ID", "reference": "{{secret:cloudgeni-cloud-auth/AZURE_SUBSCRIPTION_ID/value}}" }
  ],
  "gitHelper": true
}
```

**Levels.** A workspace has at most one profile, used by every chat in it. A
chat can add its own profile, which the chats it starts inherit, the same way
the vault policy propagates. A command receives the workspace entries, then
each chat's entries from the root chat down to its own; a nearer level
replaces an entry with the same name (ignoring case). `gitHelper` follows the nearest level
that sets it and is off by default. Nothing is configured until someone sets a
profile.

**Delivery.** For each `exec_command` (including commands that keep running in
the background) and each `run_on` exec, the runtime resolves the effective
profile through the attempt's `SecretResolver`, so the vault policy, "Ask me
each time" approvals and the audit trail apply exactly as for a written
reference. Values ride the same in-memory carry as references
(`packages/runtime/src/sandbox/secret-delivery.ts`): Connected Machines receive
them in `ExecRequest.env`, and managed sandboxes export them from the 0600 env
file that is sourced and deleted in the same command. They exist only in the
command's process environment, never in the command text, stored tool
arguments, git config or files left on the machine. They are resolved through
the attempt's own resolver, so they are known values like any other
([Masking](#masking)): a command that prints one (`env`, `printenv`,
`gh auth status -t`) shows its reference in the tool result instead, within
that section's limits (values shorter than 8 characters, plain `text` fields
and values read with `secret_get` stay as they are). Masking is a safety net,
not a reason to print them. Profile variables are applied first, so anything the
command sets itself (`GH_TOKEN=… gh …`, `export`, a reference) wins. Each
command also gets `OPENGENI_CREDENTIAL_PROFILE_VARS`, the comma-separated names
(never values) the profile delivered. The profile is read again at most every
few seconds, so a change applies to the next commands without restarting
anything; a read that takes longer than about two seconds or fails uses the
last profile read in the attempt, or none, so a slow database never stalls
commands. Only one read runs at a time; once a command stopped waiting for it,
later commands use that fallback without waiting until it finishes (a stuck
read is replaced after 30 seconds).

**Lenient.** A profile never fails a command. An entry that cannot be resolved
(missing secret, policy, waiting for approval, provider unavailable, too large
or binary) is skipped and the command runs without it; the tool result ends
with a short note such as `[Note: credential profile skipped AZURE_TENANT_ID
(secret not found)]`. Each distinct note is shown once per attempt, not on
every command. A password manager that does not answer within about 15 seconds
skips its entries the same way; that lookup is not cancelled, so it can
still use an "Allow once" approval and be recorded in the audit trail even
though the command ran without the value. A managed sandbox that cannot receive the env
file (for example an OpenSandbox backend, which has no private file writes)
runs the command without the profile and says so once. An agent with secrets
turned off runs without the profile and without a note. An entry waiting for
the person's approval is asked for once per attempt; approving it with "Allow once" covers one command, so use a
longer approval for an item every command needs. Notes never show values.
Entries resolve only after the command's own references resolved. Entries from
connected vaults (1Password and similar) are read per command and count toward
the per-attempt provider read limit, so prefer Opengeni vaults for profile
items that every command uses.

**Git helper.** With `gitHelper: true` and `GH_TOKEN` set by the profile,
each command also gets per-command git configuration through
`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_n` and `GIT_CONFIG_VALUE_n`: for
`https://github.com` it first clears the machine's own credential helpers and
then adds one that answers git's `get` request with `GH_TOKEN` from the
environment (user `x-access-token`). Nothing is written to global or repository
git config, and other hosts keep the machine's configuration. This needs git
2.31 or later; older git ignores the variables. On a Connected Machine whose
own environment already sets `GIT_CONFIG_COUNT`, the helper's entries replace
the first ones for that command, so put such settings in the profile instead.

**Precedence on managed sandboxes.** A profile is an explicit choice, so it
wins over the platform's repository bindings for the variables it delivers:
the git helper replaces the binding's helper for `github.com`, and the `gh`,
`glab` and `az` wrappers keep a profile-delivered `GH_TOKEN`, `GITLAB_TOKEN` or
`AZURE_DEVOPS_EXT_PAT` (they read `OPENGENI_CREDENTIAL_PROFILE_VARS`) instead
of replacing it with the binding token. Without a profile entry for that
variable, the bindings work as before. Host run credentials
([credentials.md](credentials.md)) are applied after the profile and win for
the same variable names. On Connected Machines there are no wrappers, so `gh`
reads `GH_TOKEN` directly.

**Rules.** Names use letters, digits and underscores, do not start with a
digit, are unique ignoring case, and never start with `OPENGENI_` (reserved).
Each entry holds exactly one `{{secret:…}}` reference; `secretfile` references
are not accepted. An escaped reference (`\{{secret:…}}`, as written for
hand-off tools) is stored unescaped. At most 32 entries; each value is capped
at 100 KiB and all profile values of one command at 256 KiB. That cap is
counted separately from the command's own references (which have their own
256 KiB cap), so one command can carry up to 512 KiB of such variables. Saving an empty profile clears that
level. Changes are audited as `credential_profile.updated` or
`credential_profile.cleared` with variable names only.

**Configuring.** Reading needs `secrets:list`. Changing needs `secrets:write`
plus `workspace:admin` for the workspace profile (the owner of a Personal
workspace changes its profile too), or `sessions:control` and the chat's
tool-policy access for a chat profile. Use the HTTP routes below or
the `secret_profile_get` and `secret_profile_set` agent tools; there is no web
UI yet. Profiles hold references, never values.

**Masking.** The worker (`agent-build.ts`) and the `run_on` path
(`apps/api/src/mcp/server.ts`) give the profile the same remembering resolver
they use for written references, so every profile value a command receives is
in the attempt's (or the `run_on` call's) known values and is masked, an `env`
dump included, within the limits in [Masking](#masking).

## Masking decision

A Knowledge decision of 5 August 2026 removed heuristic redaction and kept
content exact. After two staging incidents on 26 October 2026 (database
connection strings printed by a command, and a resolved token stored in a
chat's first message), Bendik's delegate approved two narrow exceptions that
supersede that decision for these cases only: masking of known secret values
(values Opengeni resolved or delivered, credential profile values included)
before storage and before the model sees them, and masking of narrow,
high-precision secret-shaped strings in tool output. Other content stays
exact. Both are implemented ([Masking](#masking)).

## Masking

Opengeni replaces secret values it knows about before text is stored or
shown to the model. A masked value is written as the reference that
resolved it, for example `{{secret:Vault/Item/field}}`, so the agent still
knows which secret it was and can keep using it by reference.

Approved on 26 October 2026, after two staging incidents that day put real
credentials into stored tool output and child-session messages. For known
values this supersedes the 5 August 2026 decision to keep content exact.

### What is known

Each agent attempt keeps one memory of secret values (`SecretValueMemory`):

- Every value a reference resolves to for the attempt, on any surface:
  `exec_command`, `write_stdin`, `apply_patch`, MCP connectors, Codex apps,
  Codemode, Opengeni's own tools and the browser. The label is the reference.
  Plain `text` fields (a username, a host name) are not secret and are not
  remembered, so pages, logs and URLs that mention them stay readable. This
  includes answers a person saved as a text field through `request_human_input`.
- Credentials Opengeni puts into the attempt itself: the Codemode bearer and
  each renewal, git tokens and broker bearers, host run credentials
  (environment values whose names say they are secret and that are at least
  12 characters long, and single-line credential files) and MCP header
  values of at least 12 characters whose names say they carry credentials
  (`Authorization`, `Proxy-Authorization`, `Cookie`, and names containing
  token, key, secret, auth, password, session or signature). Headers such as
  `Accept` are not remembered. The label is a marker such as
  `[opengeni credential: codemode token]`.
- Best effort, the hosted vault values of secrets the session's root tree
  used before, found through the `vault.secret.used` audit rows. They are read
  with the attempt's own vault reach, decrypted in memory and never
  delivered, so they count as neither a use nor an approval. Connected vaults
  are skipped. Tool results wait (at most 2 seconds) only for the first load.
  Later refreshes run in the background, at most every 10 seconds, and take
  effect from the next result, so values resolved elsewhere, for example by
  `run_on` or the browser, are learned too. Each refresh reads audit rows
  from 30 seconds before the previous refresh onwards (so a use committed
  late is still read) through a partial index on `vault.secret.used` rows.
  These values are labelled with the reference's ID form, which names the
  same field from any session in the tree. Plain `text` fields are skipped.
  A failure only logs a metadata-only warning.

The memory holds a bounded number of values. Over the limit the oldest go
first, but Opengeni's own credentials stay. It is cleared when the attempt
ends.

`secret_get` is Opengeni's explicit, audited read of a plaintext value. The
value it returns is shown as returned and is not masked again for the rest of
that attempt, since the agent asked for it on purpose. Values inside it
(the password of a revealed database URL) are released with it: they are
shown as written wherever they appear, and not captured. This holds for a
direct call and for a Codemode script's call, and a base64 result (a file
field) reveals both the encoded and the decoded text. Only Opengeni's own
`secret_get` reveals; a connector's tool with the same name does not.

### Matching

- Each value is searched as written, trimmed, line by line, JSON-escaped (once and twice), percent-encoded (URI
  component, `+` for spaces, form encoding) and base64 (standard and URL-safe,
  standalone and inside a longer base64 run such as a Basic auth header).
- Lines of a multi-line value are searched on their own only when they look
  like key material: at least 16 characters that are pure hex, or base64
  characters with an upper-case letter, a lower-case letter and a digit, such
  as the body lines of a PEM key. Ordinary lines such as `NODE_ENV=production`
  or `production-cluster-name` are not searched alone.
- Values shorter than 8 characters are never searched. Shorter values are
  PINs, one-time codes, ports and short words that would mangle unrelated
  text, while real passwords, tokens and keys are longer.
- The longest match wins, and masking is idempotent: references and markers
  already in the text are kept. Only the labels the memory itself writes and
  the `[opengeni credential: …]`, `[masked …]` and `[secret]` markers are
  kept; a value that appears inside text that merely looks like a reference
  is still masked.
- A value cut off just before a truncation mark (`...` or `…`), or at the
  end of a text of at least 1,024 characters (output clipped to a size), has
  its visible start replaced too, when at least 16 characters and at least
  half of the value are visible. Shorter tails are left alone, since many
  unrelated strings share a short prefix with a secret. Each cut is one
  lookup in an index of value starts, built for the value as written,
  trimmed and JSON-escaped (not its encoded forms; browser and desktop
  results, whose typed values are short, index every form, including
  lines and percent-encoded forms). The work is bounded: at
  most 256 marks per text (a run of marks such as `......` counts once), at
  most 200,000 index entries in total (the longest values beyond that are
  matched whole only), and values longer than 8,192 characters are matched
  whole only.
- File and image payloads keep their exact bytes: a string that is entirely
  a base64 data URL (`data:<type>;base64,<base64>`) and `data` fields beside
  a MIME type. A payload of a text type (`text/*`, JSON, XML, YAML and
  similar) is decoded, searched and encoded again, so it stays valid base64;
  when the decoded text holds nothing known, the payload as written is
  searched too (some tokens are themselves valid base64).
  Any other text, including a plain data URL or text after one, is searched.

### Where it applies

1. Every tool result before the model sees it: sandbox tools (including
   `exec_command`, `write_stdin`, `command_read` and `command_wait`), MCP,
   Codemode, Opengeni's own tools and tool search dispatch. A tool's error
   (message, stack and causes) and an oversized result spilled to a file are
   masked the same way.
2. Every model request: a final filter masks the whole model input, so no
   path into history can carry a known value to the provider. It runs after
   every filter that can add input (the host, tool-output and modality
   filters); the context filter after it only shortens or drops items. It
   covers the instructions too. Model-context
   snapshots are stored masked, and context compaction masks what it sends
   to the summarizing model.
3. Storage, as a backstop inside an attempt: conversation columns (session
   events, history items, turn prompts, initial messages, realtime entries,
   system updates and run state) mask in their codec. Messages to other
   sessions, goals, notes and command output are masked before their
   idempotency checks. The Codemode journal stores references, which a script
   can pass on to its next call.
4. Opengeni's own tools: the worker sends the values a call's arguments
   resolved to in that call's MCP `_meta` (never logged). The first-party
   server masks the call's result, its errors and everything the call stores
   with them. It honours these values only from an agent attempt's worker.
   `run_on` masks its result and its errors with the values it resolved.

Hosted tools that are not function tools, such as the provider's own
`apply_patch` and computer tools, are covered by the model-input filter and
the storage backstop rather than at the tool.

Masking never fails a tool call or a turn. An internal error keeps the text
as it was and writes a metadata-only diagnostic.

### Secret-shaped values in tool output

Some secrets were never in a vault, for example a database URL a command
prints from a Kubernetes secret. Tool results (and their stored copies) are
also searched with a small set of high-precision detectors, and only the
secret part is replaced:

- The password of a URL with userinfo, any scheme (`postgres`, `mysql`,
  `mongodb+srv`, `redis`, `amqps`, `https` and others):
  `postgres://user:<masked>@host:5432/db` keeps the user, host and database.
- `password=` and `pwd=` values in connection strings: written without
  spaces around `=` (plain, quoted or in braces), as a URL query parameter or
  on a line that also has a host, server, database, user, port or SSL key
  written the same way. In the `Key=value;` style (after `;`, `?`, `&` or at
  a line start) a plain value runs to the next `;`, unless it is lower-case
  code such as `config.password`. In the keyword style
  (`host=db password=…`, `connect(…, password=…)`) it also ends at a comma,
  bracket or parenthesis, and code such as `password=args.password` or
  `password=os.environ["DB_PW"]` is not a value. Source code such as
  `const password = config.password;` is not a connection string.
- Azure `AccountKey=` (also `StorageAccountKey=`) and `SharedAccessKey=`
  values written without spaces around `=` as a base64 key of at least 40
  characters with a digit (real keys have 88 or 44), and SAS `sig=` values.
- PEM private key blocks, whole, cut off, or only their end (a later chunk of
  streamed output). A body needs at least 64 base64 characters. A cut-off
  key needs a line break right after its BEGIN line and covers only base64
  lines (and `Proc-Type:` and `DEK-Info:` headers) after it.
- Well-known token formats: GitHub (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`,
  `github_pat_`), OpenAI (`sk-proj-`, `sk-svcacct-` and `sk-admin-` keys of 40
  or more characters, and legacy `sk-` keys without hyphens), Anthropic
  (`sk-ant-`), Slack (`xoxb-`, `xoxp-` and similar with a numeric id, and
  `xoxe` rotated tokens), Stripe secret and restricted keys, npm,
  GitLab, Google `AIza`, 1Password service account tokens, Opengeni's own
  bearers (`ogk_` and `ogp_` keys, and the signed `ogd_`, `oge_`, `ogr_` and
  `ogs_` envelopes) and JWTs. URLs are also found inside JSON-escaped text.

Tokens must contain a digit, and placeholders such as `${PASSWORD}` (or any
`${…}` template), `$(cat file)`, `<password>`, `%(password)s`, `@Password`,
`****`, `your_account_key_here` or the word `password` are ignored. There is no generic
"long random string" rule: UUIDs, git SHAs, base64 data, prose such as
"password: required" and URLs without a password stay untouched.

Each detected value is saved into the root session's Task vault (hosted and
encrypted), as one item per value: a login item for passwords, an API key
item for tokens and keys, a secure note for private keys. The item name is
the kind plus the first 16 hex characters of an HMAC-SHA256 of the value,
keyed with the deployment's encryption key, so the same value maps to the
same item and is saved once. The value is replaced by a reference to that
item, for example `{{secret:Task/url-password-0123456789abcdef/password}}`,
so the agent can still use it in a later command without seeing it. A URL
with the reference in its password position works when used whole in a
command. The value is saved exactly as it appeared, so a key found inside
JSON keeps its escaped line breaks. An existing item is reused only while it
still holds the same value.

A detected value is masked wherever a detector finds it. It also joins the
attempt's known values, and so is masked in any text afterwards, only when
it is distinctive: at least 16 characters with three kinds of characters
(lower case, upper case, digits, others), or 24 with two, and not the user
name beside it. A weak or common password such as `postgres` would otherwise
mask ordinary words.

The save runs as the agent attempt, with the same Task vault access as
`secret_save` to Task, and is audited like any other secret write
(`vault.item.created`, metadata only). A tool result waits at most 5 seconds
for it. Up to 16 values are saved per result, four at a time; the rest are
saved from a later result. A value that got a marker is detected and saved
again from the next result that contains it. An attempt captures into its root session's Task vault only
while it holds fewer than 200 captured items (attempts running at the same
time in one session tree can go slightly over). A session whose first-party
permissions are narrowed to a list without `secrets:use`,
`variable-sets:use`, `variable-sets:attach` or `environments:use` has no Task
vault, so its attempts do not try to save and use markers from the start.
When saving is not possible (the secrets capability is off, the agent may not
use secrets, the attempt cannot write to the Task vault, the capture or vault
limit is reached, any error), the value is replaced by a marker such as
`[masked url password]` and the tool call still succeeds. After three failed
saves in a row an attempt stops trying and writes markers. A save that
finishes after the wait upgrades the marker to the reference from the next
result on.

Shape masking applies only to tool results and their stored copies (tool
output, command output, Codemode settlements). Messages a person types,
commands as written and files on disk are not changed. Shapes inside a
value `secret_get` returned (for example the password of a revealed database
URL) are neither captured nor masked, here or in other output (see What is
known).

### Limits

- Text a person types, and files on disk, are not changed.
- A value split across two streamed output chunks is masked where it is read
  whole (the tool result and model input), not in the stored chunks.
- Output a background command produces while no attempt is running is stored
  as written and masked when a later attempt reads it.
- Multi-line credential files, values shorter than 8 characters and earlier
  values from connected vaults are not searched.
- A value the agent read with `secret_get` stays readable for the rest of
  that attempt.
- The past-uses lookup reads at most 500 audit rows per refresh, newest
  first, so in a very long session tree the oldest uses may not be loaded.
- Shape detectors read the first 4,000,000 characters of one text.
- A URL password or connection string split across two stored output chunks
  is masked where the output is read whole, not in the stored chunks. A
  private key split that way is masked in both chunks.

Masking is a safety net. It is not a reason to print secrets.

### Matchers for other code

The matchers are pure and deterministic and live in `@opengeni/contracts`
(`packages/contracts/src/secret-value-masking.ts`): `SecretValueMemory`,
`compileSecretValueMasks`, `maskSecretValues`, `maskSecretValuesInText`,
`maskSecretValuesInError`, `secretValueForms`, `isBase64DataUrl`, the
`secret_get` reveal helpers and the label helpers. The shape detectors live in
`packages/contracts/src/secret-shape-masking.ts` (also the
`@opengeni/contracts/secret-shape-masking` subpath): `detectSecretShapes`,
`collectSecretShapes`, `maskSecretShapesInText`, `maskSecretShapes`,
`SECRET_SHAPE_KINDS` and `secretShapeMaskLabel`. The database backstop is
`withSecretValueMasking`, `maskSecretValuesForStorage` and
`maskToolOutputForStorage` in `@opengeni/db`. Item names for captured values
come from `secretShapeItemName` in `@opengeni/core`.
Browser and desktop observations use the same engine with a 4-character
minimum for typed values.

## Asking a person

`request_human_input` supports a `kind: "secret"` question. The card shows a
masked field, an optional username, a password generator when the agent sets
`allowGenerate`, and where the value will be saved (`saveTo`: Only me,
workspace or task). The submitted value is written to a vault in the same
transaction as the answer; the agent receives only the reference, username and
vault name.

- Only hosted vaults can be the target. Saving to Only me needs a signed-in
  human answering.
- `itemType` may be `login`, `api_key`, `note`, `card`, `identity` or
  `ssh_key`. An SSH key question takes a pasted private key and saves its
  public key and fingerprint with it; it offers no Generate button (agents
  make new key pairs with `secret_save`'s `generateKey`). Card, identity and
  SSH key fields never offer a generator or password autofill. Files and
  passkeys are not asked for in a card.
- Slack, push and email show a link to the card instead of collecting values;
  a value pasted into a Slack thread is never saved as an answer or to a vault,
  though the message itself stays in Slack and in Opengeni's Slack inbox. Voice
  tells the person to answer in the app.
- `session_human_input_respond` from another agent accepts only a reference or
  a generate request, never a raw value.

## Approval for each use

A person can mark an item, or single fields of it by name, as "ask me each
time" on the item's page, and an agent can add marks for them. Agents still
list the item, see its fields and write
references to it; only the use of a marked value waits for a person. The same
rules apply to hosted and connected vaults and to every surface, because the
check sits in the one resolver (`createSecretResolver`), after the references
are matched and before any provider read or decryption.

When an agent's call uses a marked value that no approval covers:

1. Nothing is run and no value is read. The resolver records a pending request
   (the chat, the item and field names, the surface, the tool and, where known,
   the destination: a page's host, a machine or a connector) and fails the call
   with `approval_required`.
2. In the same step Opengeni posts its own approval card in the chat: a
   human-input request with origin `secret_use_approval` whose single,
   unskippable question (id `secret-approval:<request id>`) describes the
   stored request in Opengeni's words. It reaches the person like any other
   question: in the chat, the inbox, a phone push and the Slack thread. The
   agent does not relay anything; its tool output only says the person was
   asked and that the answer will arrive as an update. An identical blocked
   use in the same chat while the request is pending reuses it and its card,
   so the person is never notified twice.
3. The card belongs to the blocked use, not to the turn: the agent keeps
   working or ends its turn, and the card, its inbox item and its pending
   entry stay answerable after the turn ends. An agent cannot post such a
   card itself; `request_human_input` refuses a `secret-approval:` question.
4. Only the person the run acts for can answer it, signed in to Opengeni
   themselves (web, desktop or phone app). Answers from other agents, parent
   chats, API keys, personal keys, connected agents or the system acting as
   the person are refused. A Slack thread reply, or a phone notification's
   inline reply, never answers it: Slack and the push point to Opengeni, and
   a thread reply while a card is pending is an ordinary message.
5. The answer becomes a grant, recorded in the same transaction:

   | Choice | Covers | Ends |
   |---|---|---|
   | Allow once | The next use of those fields in this chat | When used, or 30 minutes after it was given |
   | Allow in this chat | Every use of those fields in this chat | When revoked |
   | Allow for 1 hour | Every use of those fields in any of the person's chats in the workspace | After an hour, or when revoked |
   | Deny | Nothing; the agent is told not to retry | |

   The same transaction gives the agent a `secret_use_approval_decided`
   update (an immediate machine input, see
   [durable agent inputs](durable-agent-inputs.md)) naming the decision and
   the item and field names, never values. It wakes an idle chat, or starts
   the next turn once a running one ends. When allowed, the agent retries the
   same call; when denied, it does not. A once grant is used up only after every
   value of the call was read, so a failed call keeps it, and two calls
   racing for one once grant cannot both use it.

Who is asked and who can change the rules:

- A person using their own reference (for example revealing it on the item's
  page) is not asked: the approval would be their own.
- A scheduled run asks the schedule's owner. A run that acts for no person
  (for example a session an API key started without one) has nobody to ask
  and is refused with `denied`, and so are Sites.
- `secret_get` never returns a marked value to an agent, even with
  `secrets:read`; the agent uses the reference where the value is needed.
- Marks and grants are listed with `GET …/items/:itemId/approval`. Changing the
  marks (`PUT …/approval`) and revoking a grant
  (`POST …/approval/grants/:grantId/revoke`) need `secrets:write` and access
  to the item. Adding marks and revoking grants only make use stricter, so API
  keys, agents and anything acting as the person (a connected agent, an agent
  with admin access, a personal API key) can do both. Removing a mark (turning
  off "every field" or unmarking a field) needs the person signed in to
  Opengeni themselves; anyone else gets `human_auth_required`, so an agent can
  never lift its own approval.
- The approval answer says what the caller may do: `canChange` (lift marks
  and revoke freely: the signed-in person) and `canAddMarks` (add marks:
  anyone with `secrets:write`). The answer to a `PUT` also carries `changed`,
  whether the marks are now different from before; `false` means the request
  matched the marks already in force.
- The secret-use audit row of an approved use lists the approvals it relied on
  (`approvalIds`) and its `destination`.

Limits:

- A grant covers its own chat. A child session the agent starts is a different
  chat and asks again (or uses an hour-long grant).
- Marks follow the item's id. If a connected vault's item is deleted and
  re-created in the password manager, it is a new item and needs marking again.
- Values the agent already received (for example in a file it wrote earlier)
  are not recalled by revoking a grant; revoking stops the next use.
- Cards are answered in Opengeni itself. A reply in a Slack or Teams thread,
  or an embedding product's server answering for its user, is refused; those
  surfaces link the person to the chat instead.

## Agent tools

With the `secrets` capability on, agents get:

| Tool | Purpose | Needs |
|---|---|---|
| `secret_search` | Find or list items by name, website, type or vault, with ready references. The first page lists every reachable vault and its item count; `nextCursor` pages through the rest (up to 1,000 items examined per call). | `secrets:list` |
| `secret_save` | Create or update an item of any type it names (logins, API keys, notes, cards, identities, SSH keys), optionally with a `category`; fields take a value, a generated password, a new SSH key pair (`generateKey`, for an `ssh_key` item's `private key`), another reference or a version to restore. | `secrets:write` |
| `secret_get` | Reveal a value to the model. Agents do not hold `secrets:read` by default. | `secrets:read` |
| `secret_move` | Move or copy an item between vaults. | `secrets:write` |
| `secret_delete` | Archive an item. | `secrets:write` |
| `secret_profile_get` | Show the [credential profile](#credential-profiles): this chat's additions and what its commands receive (`scope: "session"`, the default), or the workspace profile. Names and references only. | `secrets:list` |
| `secret_profile_set` | Replace this chat's profile (inherited by the chats it starts) or, with `scope: "workspace"`, the workspace profile. References are stored as written, never resolved. | `secrets:write`, plus `sessions:control` (chat) or `workspace:admin` (workspace) |

Discovery with no filters lists items; an empty query is not required. Keep
the same filters when following `nextCursor`. Provider freshness is reported
separately from pagination: `complete: false` means a relevant source could
not be checked, not that the caller should guess a different spelling. Use
`refresh: true` deliberately to recheck metadata and invalidate cached values;
it does not bypass provider rate limits. Check each source's `freshness` and
retry time before concluding that an empty list proves absence.

The always-on prompt block teaches the reference syntax and the login ladder
(reuse a session, sign in with the saved login and `/otp`, enroll your own 2FA,
read email or SMS codes through connectors, create accounts with generated
passwords when the task allows it, solve CAPTCHAs). Playbooks live in the
bundled `secrets` skill.

The retired `variable_set_*` and `environment_*` tools are no longer offered.

## Providers

**1Password.** Install a service-account token with
`POST /v1/workspaces/:workspaceId/connections/1password/install`, then link
vaults with `POST /v1/workspaces/:workspaceId/vaults/link` (read-only or
read-write) or create a managed vault with
`POST /v1/workspaces/:workspaceId/connections/:connectionId/managed-vaults`.

- Managed creation checks the exact local link policy before creating upstream:
  name conflicts, quota and authority refusals leave no upstream vault. The
  preflight reserves nothing, so a racing change may still refuse the link.
  If creation succeeded but a later step fails, the error carries
  `details.created: true`, `connectionId`, `externalVaultId`, and `linked`
  (true, false for a known refusal, null when the link outcome is uncertain),
  plus `vaultId` when known. Link that existing vault under an available name,
  or refresh its existing link; do not create it again. A failed optional group
  grant still links the created vault and reports `groupGrantConfirmed: false`;
  check sharing in 1Password. Neither failure triggers automatic retries or
  upstream deletion. If the create itself has an unknown outcome, inspect the
  provider vault list first; a lost response cannot guarantee exactly-once creation.
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
- Opengeni mirrors item metadata, including a username display hint when the
  provider already has it in its inventory. This hint is encrypted with the
  existing vault envelope key, bounded to 1,024 characters (empty or longer hints are
  omitted), and cleared when the provider stops reporting it. Old providers
  may omit it. Passwords and other field values are fetched live and cached per
  attempt for at most 60 seconds, with at most 50 provider reads per attempt.
- Edits in a read-write linked vault are written to 1Password first, then the
  mirror refreshes. A changed item returns `provider_conflict`.
- Items added or changed straight in 1Password show up without pressing Sync:
  agent search and opening the vault in the app refresh a linked vault's mirror
  when it is more than 10 minutes old, and a reference that finds nothing
  refreshes mirrors more than 2 minutes old and looks again. A refresh costs one
  `vaults.list` call and lists items only when the vault changed; a vault that
  failed to sync is retried at most once per period, and a rate limit is waited
  out.
- Concurrent refreshes compare the cache epoch captured before provider I/O.
  Mirror and status/freshness settle together; a late result cannot overwrite
  another completed refresh, even an unchanged check or a failure. The first
  settlement wins without comparing opaque provider versions. A superseded
  refresh does not retry automatically; subsequent checks use the settled state.
- A personal (Only me) connection's token is used for its owner in every
  workspace their Only-me vaults reach, and an organization connection serves
  its organization vaults in every workspace they are available in, whichever
  workspace the token was added in.
- A per-connection budget follows the plan tier (Family 1,000, Teams 5,000,
  Business 50,000 reads a day). Rate limits set the vault's sync status to
  `rate_limited` with a retry time; expired tokens show `auth_expired`.
- The SDK lives in `packages/vaults-onepassword` and is only loaded by the API
  and worker. Their images keep `@1password/sdk` as an installed package
  rather than bundling it, because its core loads a WASM file from beside its
  own module.
- Copying between hosted and linked vaults is supported when the destination
  can create the item type. Moving additionally requires recoverable removal
  at the source. Provider field-history restoration is not offered, and file
  fields are written only where the provider stores files. Provider removal
  never means permanent deletion.
  Moves are not atomic across providers; see the [source-version check and
  recovery guidance](external-vaults.md#moving-and-copying).
- A connected vault's archived items stay in its mirror, marked archived, and
  are listed with `includeArchived=true` (`1` and `yes` work too). Which
  items count as archived is the provider's: shared by everyone in 1Password,
  per person in Bitwarden (see
  [Bitwarden and Vaultwarden](external-vaults.md#bitwarden-and-vaultwarden)).

**Host provider (embedders).** Products that embed Opengeni can supply a
`vaultProvider` implementing `VaultProvider` from `@opengeni/vaults`; link its
vaults with `provider: "host"`. This replaces the removed `sandboxSecrets` port.
See [embedding.md](embedding.md).

**Additional providers and remote hosts.** Proton Pass, Keeper Secrets Manager,
Bitwarden Password Manager (including Vaultwarden), and generic
remote vaults use the same native ownership, references and discovery. Their
write capabilities differ; a connected vault is not automatically fully
editable. See [external-vaults.md](external-vaults.md) for setup, the supported
operations, freshness, and the distinction from renewable run credentials.

**Remote vaults (signed protocol).** A password manager can also be served
from the customer's own server over `opengeni.vault.v1`: Opengeni signs each
request (`OpenGeni-Signature` over the exact body) with the connection's
secret, and the server signs its response with a key derived from the same
secret. Embedders build the server with `createExternalVaultReceiver` from
`@opengeni/sdk/external-vault-receiver` (server-only). It checks the
signature, request age and replay, then calls the host's `authorize` to map
Opengeni's account, workspace and user to its own tenant and user on every
request; a valid signature alone authorizes nothing. Writes are claimed in a
caller-owned durable store under their idempotency key and never retried; an
uncertain write returns `provider_outcome_unknown`. Listings carry metadata
only, in bounded pages from one snapshot. The ask card still saves answers
into Opengeni-hosted vaults only.

For local development, `OPENGENI_ONEPASSWORD_FAKE_TOKENS=1` enables the
in-memory fake provider tokens `ops_fake_healthy` and `ops_fake_sync_error`.
Managed runtimes refuse to start with it set.

## Removing secrets from stored history

A secret that already reached a session's stored history (pasted into a
message, printed by a command, or resolved into a hand-off before references
were kept) stays there until it is removed. A workspace admin, or the owner of
a Personal workspace, removes it with
`POST /v1/workspaces/:workspaceId/secret-redactions`:

```json
{
  "sessionIds": ["…"],
  "includeDescendants": true,
  "match": { "reference": "Vault/Item/field" },
  "dryRun": true
}
```

- `match` is either a vault reference, written with or without its braces,
  or built-in patterns:
  `{ "patterns": [{ "kind": "url_password", "hosts": ["db.example.com"] }, { "kind": "github_token" }] }`.
  `url_password` finds the password in `scheme://user:password@host` URLs, for
  every host or only the hosts named; `github_token` finds GitHub token
  shapes, including one inside a longer URL password. Both use the masking
  module's own matchers, so a reference finds its
  value in every form masking recognizes (as written, JSON-escaped,
  percent-encoded and base64) and the patterns find exactly the shapes masking
  catches.
- A reference's value is read in memory for matching only. It is never
  returned, logged or written to the audit event. The caller needs
  `workspace:admin`; a reference also needs permission to use that item
  (`secrets:use`, which workspace owners and admins hold unless a grant with
  explicit permissions leaves it out). A value shorter than masking searches
  for (8 characters, not counting surrounding whitespace) answers 422, so a
  run can never rewrite everything; so does a value holding `[redacted: …]`
  text, since that part may be a kept marker.
  Every named session (and descendant) must be one the caller may change; one
  that is not answers 404.
- Each match becomes `[redacted: <reference or kind>]`, for example
  `[redacted: secret:Vault/Item/field]` or `[redacted: url_password]`. The
  marker names the reference without its braces, so it can never resolve back
  into the value. Everything else in the text stays exact.
- `dryRun: true` counts without changing anything. Running the same request
  again is safe: markers are never matched, so the second run finds nothing.
  A later run with another reference never rewrites a marker an earlier run
  wrote, even when its value appears in that marker's label. Text that only
  looks like a marker (a label the scrub never writes) is searched like any
  text; text typed exactly like a reference marker
  (`[redacted: secret:Vault/Item/field]`) is kept as is, like a real one.
  Run patterns before references for the same sessions: once a URL's
  username is replaced, `url_password` no longer recognizes that URL.
- The response has counts only, per table and per session (`rowsMatched`,
  `rowsChanged`, `matches`), the places still `pending` (below) and any
  `failures` by table and error code. A failure never stops the run; run it
  again to retry. `mirror_row_unreadable` means a search-mirror row still could
  not be decoded after the run rebuilt it from its event, so it could not be
  checked. `cell_not_rewritten` means a matched copy is still stored (it
  changed under the run, a check refused the edit, or something still refers
  to a matched content blob).
- A session with a turn in progress is skipped (failure `session_active`):
  the turn could write the text again from memory. So is a session being
  moved to long-term storage (`session_archiving`): its export could keep the
  old copy. A dry run still counts both. Run again once it is idle or
  archived. Every write also takes the session's ordinary writer lock and
  rechecks this. Before the archive pass, every session listed as live is
  read again: one archived during the run has its archive scrubbed too, and
  one still being moved is reported as `session_archiving`.
- An audit event (`session.secret_history.redacted`, or
  `session.secret_history.counted` for a dry run) records the match label,
  sessions and totals, and is written even when the run stops part way
  (`outcome: "failed"`).

What is rewritten: every stored copy in the chosen sessions: the session row
(title, first message, instructions, metadata), turns (prompts, model context
and the frozen goal), timeline events and the message search mirror, model
history, pending tool calls, realtime entries and projections, model-request
snapshots and the content blobs they point to, code-mode calls, background
commands, machine inputs (scheduled ones included) and their outbox,
human-input requests, run states, command receipts, unsent composer drafts,
connector action reviews, feedback comments and context, session list
snapshots, goals and goal revisions, task notes, MCP operation results, host
export payloads and the history repair audit, and, for a session in
long-term storage, its archive bundle and transcript
(docs/session-storage-lifecycle.md, "Removing secrets from the archive").
Each table is read in bounded pages, one transaction per page, under the
caller's row-level security; a cell is rewritten only while it still holds
what was read, so a concurrent writer is never overwritten. JSON keys are
never rewritten, only string values. Content blobs are content-addressed: a
model request is redacted whole (a secret can straddle two body chunks), then
re-encoded into new blobs, and every old blob nothing refers to any more is
deleted, along with any other unreferenced blob of the session created at
least ten minutes ago (a chunk a failed earlier run left behind may hold part
of a split secret). Those deletions count in the blobs' `rowsChanged` only,
so it can be higher than `rowsMatched`. The search mirror is rebuilt from the
scrubbed events, and its `rowsChanged` counts the rows rebuilt. The patterns
scan a very large cell in windows cut at whitespace or quotes, so a long cell
is searched whole.

Goal text, goal revisions, a turn's frozen goal, task notes, the search
mirror, machine inputs, content blobs (and so the model-request snapshots
that keep their content in them), MCP results, host export payloads, the
repair audit and the archive manifest are written only through two owner
routines (1091). The cell writer re-reads each cell, checks it belongs to the
named session, and accepts only text that is the old text with spans
replaced by `[redacted: …]` markers; goal text keeps its length limit. The
guards on immutable records (goals, frozen goals, settled MCP results,
scheduled occurrences, archived sessions) let only that writer through, by a
capability row it holds for its own transaction. Their runtime grant follows
one release later, as for every new private routine
(docs/migrations-expand-contract.md); until then the response lists those
places in `pending` and still counts what it can read. Run the request again
once they are granted.

Not covered, by design or for now:

- Other sessions that copied the text: a fork or a session that received it
  in a message is its own session; name it too. `includeDescendants` follows
  child sessions up to 64 levels deep.
- Document inspection receipts stay immutable; they hold artifact
  observations, not conversation text.
- Inbox items and phone push records keep their own copies of a reply's
  first lines, a question's prompt and choices, an approval's title, a
  paused goal's reason and the agent's notifications; push records also
  copy the chat's title. The scrub does not rewrite them. Push records are
  deleted a week after they are delivered or given up on.
- Opengeni's Slack inbox keeps the text of incoming Slack messages, and a
  message the agent posts as the Opengeni Slack bot is saved with its text
  before it is sent and kept until the chat or the Slack connection is
  deleted.
- An MCP operation's `receipt_digest` is not recomputed after its result is
  rewritten, so re-settling that exact operation later reports a conflict
  instead of replaying.
- Files, artifacts, recordings, screenshots, Knowledge, workspace files,
  sandbox disks, provider-side stored responses, and logs or telemetry
  outside Opengeni's database and archive. Rotate a credential that reached
  any of these, or a model provider.

Masking (parts B and C of the credential work) keeps new copies out; this
removes old ones. Both supersede, for those two cases only, the 5 August 2026
decision to keep all stored content exact without heuristic redaction: known
secret values and a narrow set of high-precision secret shapes are now masked
or removed. Everything else stays exact.

## HTTP API

All routes are under `/v1/workspaces/:workspaceId`.

| Route | Purpose |
|---|---|
| `GET, POST /vaults`; `GET, PATCH, DELETE /vaults/:vaultId` | Vaults |
| `GET, POST /vaults/:vaultId/items`; `GET, PATCH, DELETE /vaults/:vaultId/items/:itemId` | Items |
| `POST /vaults/:vaultId/items/:itemId/restore`, `/move` | Restore an archived item; move or copy |
| `POST …/fields/:fieldId/reveal`; `GET …/fields/:fieldId/versions`; `POST …/fields/:fieldId/restore` | Plaintext, history, version restore |
| `GET, PUT /vaults/:vaultId/items/:itemId/approval`; `POST …/approval/grants/:grantId/revoke` | "Ask me each time" marks and the approvals in force |
| `PUT /sessions/:sessionId/vault-policy`; `GET /sessions/:sessionId/secrets` | Session policy and the secrets a session has used |
| `GET, PUT /credential-profile` | The workspace [credential profile](#credential-profiles): `{profile}`; `PUT` takes `{entries, gitHelper?}` and needs `secrets:write` plus `workspace:admin` (or owning the Personal workspace) |
| `GET, PUT /sessions/:sessionId/credential-profile` | A chat's own profile and its effective profile `{profile, effective}`; `PUT` needs `sessions:control` and `secrets:write` |
| `POST /connections/1password/install`; `GET /connections/1password/service-accounts`; `GET /connections/:connectionId/provider-vaults` | 1Password connections |
| `PUT /connections/:connectionId/1password/token`; `DELETE /connections/:connectionId/1password` | Replace a 1Password token; disconnect (unlinks its vaults) |
| `POST /vaults/link`; `POST /vaults/:vaultId/sync` | Provider vaults |
| `GET, POST /vault-providers/connections` | Unified connection metadata; install a first-wave provider |
| `PUT /vault-providers/connections/:connectionId/credentials` | Reconnect without changing linked vault identities |
| `POST /vault-providers/connections/:connectionId/verify` | Finish pending setup using saved credentials, without replaying a bootstrap token |
| `DELETE /vault-providers/connections/:connectionId` | Unlink locally and revoke stored access; never delete upstream items |
| `POST /secret-redactions` | Remove a secret from chosen sessions' stored history (admin or Personal owner; counts only) |

Errors use `{error, message, details?}` with the codes in `VaultErrorCode`
(`packages/contracts/src/vaults.ts`).
A writable connected vault that cannot do one particular thing (an item type,
a file, a one-time password) answers `vault_operation_unsupported` (422) with
the `operation` in `details`; `vault_read_only` (403) means it takes no writes
at all. A query the item listing cannot read answers `validation_failed`
naming each bad parameter in `details.issues`.

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

The old set tables are inert: nothing reads or writes them, and a later
contract migration drops them. The Variable Set routes, request and response
fields, SDK methods and settings page are gone, and the retired
`variable-sets:*` and `environments:*` permissions were rewritten to the
matching `secrets:*` permissions.

Anything that read a set's variables from the environment must now reference
them explicitly.
