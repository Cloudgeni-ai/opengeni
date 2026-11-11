# Account creation

When the task allows creating accounts (the user asked you to sign up, set
something up on a service, or said you may create accounts), create the
account yourself and generate its password without asking. The item is saved
where the user can see it, so nothing is hidden from them.

## Steps

1. `secret_search {website}` first, so you do not create a duplicate.
2. Save before you submit:

   ```json
   {
     "item": "Acme Cloud",
     "saveTo": "user",
     "type": "login",
     "websites": ["https://app.acme.example"],
     "username": "jane@example.com",
     "fields": [{ "name": "password", "generate": { "length": 24 } }]
   }
   ```

   The result has `references` (for example `{{secret:Acme Cloud}}`) and
   `generatedFields`; the value is never echoed.
3. Fill the sign-up form with the references and submit.
4. Verify the email address through the connected mail tools.
5. Enroll your own TOTP (`2fa-enrollment.md`) and save the browser session
   with `browser_publish`.
6. Tell the user the item name and vault where the login is saved.

## Generate spec

Defaults: `length` 24 (8 to 128), `lowercase`, `uppercase`, `digits` and
`symbols` all on, `symbolSet` `!#%+-.:=?@_`, `excludeAmbiguous` and
`requireEachClass` on. The defaults avoid quotes, `$`, backticks, slashes and
braces, so values are safe in shells and URLs.

If the site rejects the password (too long, no symbols, a required symbol),
update the item with a matching spec, for example
`{"symbols": false, "length": 16}` or `{"symbolSet": "!@#"}`, using
`mode: "update"`, then fill the form again with the same reference.

## Choosing the account details

- Email: the address the task names, else the user's connected email.
- Owner: `saveTo: "user"` by default; `workspace` for team or service
  accounts; `task` for throwaway test accounts.
- Record `websites` and `username` so later searches find the item.
