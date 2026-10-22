# The secret card

Ask only for what only the user has, and only after searching, the other
ladder rungs, and account creation (when allowed) do not work. Never ask for a
password, key or code in chat or in a plain `text` question. A
`request_human_input` question with `kind: "secret"` shows a secure card; the
value goes straight into a vault and you get a reference back.

## A missing-secret error already contains the card

When a tool fails with `secret_reference_error` and a `not_found` failure, the
result includes `askCard`: a complete `request_human_input` input. Make that
call as given. You may adjust only `saveTo` and `prompt` (say why you need it).
Then retry the original action with the returned reference.

## Question shape

```json
{
  "id": "github_login",
  "kind": "secret",
  "prompt": "Your GitHub password, so I can sign in and open the release pull request.",
  "secret": {
    "item": "GitHub",
    "field": "password",
    "fieldKind": "concealed",
    "itemType": "login",
    "username": { "prompt": "GitHub username or email" },
    "website": "https://github.com/login",
    "saveTo": "user",
    "allowGenerate": false,
    "autocomplete": "current-password"
  }
}
```

Fill the remaining question and request fields as the tool schema requires.

| Field | Use |
|---|---|
| `item` | item name to create or update; name it after the service |
| `field` | field name, default `password` |
| `fieldKind` | `concealed` (default), `totp` (a seed or `otpauth://` URI), `text` |
| `itemType` | `login` (default), `api_key` (field `value`), `note` |
| `username` | for logins: `{prompt, value?}`; `value` pre-fills a known username |
| `website` | the sign-in URL; helps the user's password manager fill the card |
| `looksLike` | a hint such as `sk-...` or `6 digits` |
| `pattern` | a regex for a soft client-side warning |
| `saveTo` | `user` (Only me, default), `task` (throwaway), `workspace` (team keys) |
| `vault` | a hosted vault in that scope, when not the default |
| `allowGenerate`, `generate` | show a Generate button for new passwords, with a spec |
| `autocomplete` | `current-password`, `new-password`, `one-time-code` or `off` |

Pick `autocomplete` to match: `current-password` for an existing login,
`new-password` with `allowGenerate: true` when the user sets a new one,
`one-time-code` for a code the user receives. Ask for several items in one
request with one question each.

## The answer

```json
{
  "questionId": "github_login",
  "answer": {
    "secret": {
      "reference": "{{secret:Private/GitHub/password}}",
      "username": "jane",
      "vaultName": "Private",
      "itemName": "GitHub",
      "saveTo": "user"
    }
  }
}
```

You never receive the value. Use the reference immediately (for example type
it into the login form). If the user skips or declines, do not ask again in
chat: continue down the ladder (another login method, account creation when
allowed) or report exactly what is blocked.
