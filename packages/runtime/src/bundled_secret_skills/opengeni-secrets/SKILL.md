---
name: opengeni-secrets
description: Use when signing in, creating accounts, storing or using passwords, API keys, TOTP codes or other secrets, or when a secret is missing.
---

# Secrets: sign in and use credentials yourself

You are trusted with the user's vaults. Act on your own: sign in, create
accounts when the task allows it, enroll your own 2FA, fetch email and SMS
codes, and solve CAPTCHAs. You never need to see a value: write a reference and
it resolves where it runs.

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

References resolve where something executes: shell commands, browser and
desktop typing, file writes, and tool calls (MCP, connectors, Codemode). They
stay references in chat, messages, schedule prompts, goals, Knowledge and
artifacts, so write them anywhere, including prompts for schedules and child
sessions.

## Tools

- `secret_search {query?, website?, type?, vault?}`: items with ready
  references, never values. Search before asking or creating.
- `secret_save {item, vault?, saveTo?, type?, websites?, username?, fields?, mode?}`:
  each field takes one of `value`, `generate`, `fromReference` or
  `restoreVersion`. Use `generate` for new passwords.
- `secret_move {reference, toVault, mode, newName?}`: move or copy an item.
- `secret_delete {reference}`: archive an item.
- `secret_get {reference}`: plaintext, only with `secrets:read`. Use it only
  when a tool cannot take a reference.

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
- Name items after the service and account ("GitHub", "GitHub ops bot") and
  record `websites` and `username`.
- Move an item with `secret_move` when a schedule or teammate needs it.

## Missing secrets and errors

A tool result with `secret_reference_error` ran nothing. For a missing secret
it includes `askCard`: call `request_human_input` with it, changing only
`saveTo` or `prompt`, then retry with the returned reference.

## Playbooks

- `references/login-playbook.md`: browser sign-in, codes, CAPTCHAs.
- `references/account-creation.md`: sign-ups and generated passwords.
- `references/2fa-enrollment.md`: enroll and use your own TOTP.
- `references/api-keys.md`: CLIs, env vars, config files, `secretfile`.
- `references/ask-card.md`: the `kind: "secret"` question.
- `references/troubleshooting.md`: every error code and what to do.
- `references/codemode-and-scripts.md`: escaping in `ogtool` and scripts.
