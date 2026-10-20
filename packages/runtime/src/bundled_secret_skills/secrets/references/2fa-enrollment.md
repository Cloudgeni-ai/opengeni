# Enroll your own 2FA

After you sign in to an account that has no TOTP of yours, add an
authenticator-app factor yourself so the next login needs no one. Do it
without asking.

## Steps

1. Open the site's security settings and choose an authenticator app (TOTP).
2. Capture the seed: most pages offer "Can't scan the code?" or "Enter this
   key manually". Read the base32 key, or an `otpauth://totp/...` URI if the
   page exposes one. A screenshot of the QR code is a fallback when the page
   shows nothing else.
3. Save it on the login item before you confirm:

   ```json
   {
     "item": "GitHub",
     "mode": "update",
     "fields": [{ "name": "totp", "kind": "totp", "value": "otpauth://totp/GitHub:jane?secret=JBSWY3DPEHPK3PXP&issuer=GitHub" }]
   }
   ```

   A bare base32 seed works too (spaces and lowercase are accepted). Do not
   name the field `otp`; that suffix is reserved.
4. Confirm enrollment by typing `{{secret:GitHub/otp}}` into the
   verification field.
5. Save recovery codes the site shows as a concealed field, for example
   `{"name": "recovery_codes", "kind": "concealed", "value": "..."}`.
6. Publish the browser session with `browser_publish`.

From now on, sign in with `{{secret:GitHub/otp}}` at the code prompt.

## Notes

- Add your factor next to the user's existing ones; do not remove or replace
  theirs. If the site allows only one authenticator and the user already has
  one, keep theirs and use the other rungs of the ladder.
- Prefer TOTP over SMS: SMS codes go to the user's phone.
- Passkeys: prefer TOTP unless the managed browser supports creating a
  passkey, in which case the passkey is saved as a vault item.
