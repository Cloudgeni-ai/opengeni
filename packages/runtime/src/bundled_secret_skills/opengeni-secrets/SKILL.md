---
name: opengeni-secrets
description: Use when signing in, creating accounts, storing or using passwords, API keys, TOTP codes or other secrets, or when a secret is missing.
---

# Secrets: sign in and use credentials yourself

Use references instead of viewing values. Sign in, create accounts when the
task allows it, enroll 2FA, fetch codes and solve CAPTCHAs yourself.

## References

| Write | Resolves to |
|---|---|
| `{{secret:Item}}` | the primary field (password of a login, value of an API key) |
| `{{secret:Item/field}}` | one field, such as `{{secret:GitHub/username}}` |
| `{{secret:Vault/Item/field}}` | a field in a named vault |
| `{{secret:Item/otp}}` | the current TOTP code, computed when the action runs |
| `{{secret:Item/field#previous}}` | the version before the current one |
| `{{secretfile:Item}}` | a temporary file path holding the value (shell commands) |
| `\{{secret:Item}}` | the literal text, left unresolved |

A reference resolves wherever it is used: shell commands, typing, file writes
and every tool call, including Opengeni's own tools. To hand one on for later
work (a schedule prompt, a message to another session, a goal, a note or
comment), escape it as `\{{secret:Item}}`; it arrives as `{{secret:Item}}`.
The `secret_*` tools take references as names and never resolve them.

## Tools

- `secret_search`: metadata and references, never values. No filters lists all;
  page one lists vaults. Follow `nextCursor` with unchanged filters. Check
  `complete` and freshness before inferring absence. `refresh: true` requests
  fresh inventory without bypassing rate limits.
- `secret_save`: each field takes `value`, `generate`, `fromReference` or
  `restoreVersion`. Generate new passwords.
- `secret_move`: move or copy to another vault.
- `secret_delete`: archive an item.
- `secret_get`: plaintext with `secrets:read`, only if references cannot work.

## Login ladder

Go down the list and stop at the first rung that gets you in. None of these
needs the user's permission.

1. Reuse a saved browser session (browser identity or `browser_auth`).
2. Sign in with a saved login: `{{secret:Item/username}}`, `{{secret:Item}}`,
   then `{{secret:Item/otp}}` at the code prompt.
3. After signing in, enroll your own TOTP so the next login needs no one.
4. Get email or SMS codes and magic links through connected mail or
   messaging tools.
5. No account and the task allows creating one: create it, saving a generated
   password with `secret_save` before you submit the form.
6. Only the user has it: ask with a secret card.
7. Hand the browser to the user only for a push approval or a hardware key.

CAPTCHAs are always yours. Solve them with screenshots, the audio option, a
reload or another attempt. Never hand a CAPTCHA to the user, and do not stop
after one failure.

## Saving

- `saveTo`: `user` (Only me, reused later), `task` (throwaway, shared with this
  task's sessions) or `workspace` (team keys, schedules that run without you).
- Name items by service/account; record `websites` and `username`.
- Respect provider capabilities. Ask cards save to hosted vaults only.
  Provider write and move limits: `references/troubleshooting.md`.

## Missing secrets and errors

A tool result with `secret_reference_error` ran nothing. For a missing secret
it includes `askCard`: call `request_human_input` with it, changing only
`saveTo` or `prompt`, then retry with the returned reference.

An unavailable or incomplete provider is not a missing secret: respect retry
times or reconnect/unlock it. Inspect unknown write outcomes before retrying;
never repeat a create just because its inventory refresh failed.

## Playbooks

- Login: `references/login-playbook.md`.
- Sign-up: `references/account-creation.md`.
- TOTP: `references/2fa-enrollment.md`.
- CLI/files: `references/api-keys.md`.
- Secret card: `references/ask-card.md`.
- Errors: `references/troubleshooting.md`.
- Escaping: `references/codemode-and-scripts.md`.
