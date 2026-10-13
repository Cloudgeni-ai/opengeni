# Troubleshooting

A tool result with `"error": "secret_reference_error"` means nothing ran. It
lists `failures` (each with `raw`, `code`, `message`), an `askCard` or `null`,
and a `hint`. Fix the reference and retry the same action.

## Reference errors

| Code | What to do |
|---|---|
| `invalid_reference` | Fix the syntax: `{{secret:Item}}`, `Item/field`, `Vault/Item/field`, `{{secret:id:<uuid>}}`, optional `/otp`, then `#previous` last; no spaces inside the braces. Names cannot contain `/ { } # \`. To write the text literally, escape it as `\{{secret:...}}`. |
| `not_found` | If you guessed the name, run `secret_search` and retry with a returned reference. Otherwise call `request_human_input` with the `askCard` from the error (adjust only `saveTo` and `prompt`), or create the account when the task allows it. |
| `ambiguous` | Two items or readings match. Retry with one of the ready references in `candidates`, which name the vault. |
| `denied` | The vault is not available to this session (narrowed access, or its owner lost access). Use another item, ask with a card that saves to a vault you can reach, or tell the user which item is blocked. |
| `no_primary_field` | The item has no default field (passkeys). Name the field: `{{secret:Item/field}}`. |
| `provider_unavailable` | The connected password manager or vault store is unreachable. Retry once shortly, continue other work, and report it if it persists. |
| `provider_rate_limited` | The password manager's quota is spent. Do not loop; wait until the limit clears, reuse references within one call, and continue other work. |
| `provider_auth_expired` | The password-manager connection needs reconnecting. Tell the user to reconnect it under Settings, Secrets; meanwhile save new items to an Opengeni vault. |
| `too_large` | The value (or all values in one command) is too big for an environment variable. Use `{{secretfile:...}}`. |
| `binary_value` | The value is binary. Use `{{secretfile:...}}`. |
| `unsupported_shell` | `cmd.exe`, `fish` or an unknown shell. Run the command with `sh`/`bash` or `powershell`, or use `{{secretfile:...}}`. |
| `secretfile_not_allowed` | `{{secretfile:...}}` works only in shell commands. Use `{{secret:...}}` elsewhere. |

## Save and vault errors

| Error | What to do |
|---|---|
| `vault_read_only` | A connected vault is read-only. Save to an Opengeni vault (`saveTo` without `vault`) or ask the user to make it writable. |
| `vault_item_name_conflict` | `mode: "create"` hit an existing item. Use `update` or `upsert`, or another name. |
| `human_auth_required` | `saveTo: "user"` needs a person in the turn (schedules and automations have none). Use `task` or `workspace`. |
| `vault_permission_denied`, `secret_save_forbidden` | This session cannot write there. Pick another `saveTo` or vault. |
| `vault_limit_reached`, `secret_value_too_large` | Archive unused items with `secret_delete`, or store large files as `file` items. |
| `provider_conflict` | The item changed in the password manager meanwhile. Search again and retry the save. |
| `secret_search_cursor_invalid` | The `cursor` came from a search with other filters, or its vault is gone. Search again without `cursor` and page from the start. |

## Other symptoms

- A literal `{{secret:...}}` reached a website or file: it was escaped
  (`\{{secret:...}}`) or written where nothing executes. Write it unescaped in
  the command, typing action or tool call itself.
- The site rejects a correct-looking login: see "When the login fails" in
  `login-playbook.md`.
