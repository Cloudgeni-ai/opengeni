# Fake-login site suite

A local website for testing agent sign-in. It covers the login methods the secrets work has to handle (design §13B.3), and it is the oracle for the BR-\*, E2E-\* and AG-6 checks. It shares no code with the product, so it can be used to test the product's TOTP, WebAuthn and typing code.

```bash
bun packages/testing/src/fake-login/cli.ts --slot 3   # site http://localhost:47220, cross-origin http://127.0.0.1:47221
```

In-process: `startFakeLoginServer({ port, iframePort, accounts })` from `@opengeni/testing/fake-login`.

## Routes (site origin `http://localhost:<port>`, rpId `localhost`)

| Route | Flow |
|---|---|
| `/password` | Username and password. Five failures lock the account for a minute. |
| `/signup` | At least 16 characters, with an uppercase letter, a digit and a symbol from `!#%+-.:=?@_`. Any other symbol is rejected. |
| `/password-change` | Requires a session. |
| `/totp/enroll` | Shows a QR code, the setup key (`#totp-secret`) and the `otpauth://` URI, then confirms a code. |
| `/totp/login` | Password, then a 6-digit code (one window of drift either way). |
| `/email-code` | Sends a 6-digit code to the fake mailbox. |
| `/otp-split` | Password, then six single-digit boxes that accept only `keydown`. Inserted or pasted text is discarded. |
| `/passkey/register`, `/passkey/login` | WebAuthn with a real verifier: signature, rpId hash, UP and UV flags, and the sign-counter rule (`counter_regression`). |
| `/popup-login` | Opens a FakeID login popup on the cross-origin server, which posts a token back to the opener. |
| `/captcha-iframe` | Login form gated by an "I'm not a robot" widget in a cross-origin iframe, with a distorted 5-character canvas challenge. |

Every successful flow lands on `/welcome` with `#logged-in[data-user][data-flow]` ("Logged in as X"). `/whoami` returns `{loggedIn, username, flow}`.

## Test surfaces

- `/state` lists successes, attempts and accounts. Submitted values appear only as `sha256:<12 hex>`, so the file is safe to keep as evidence.
- `/__fake/received` (and `server.received()`) is the exact received-credential log, held in memory only. Tests use it to assert that the exact value arrived. Log lines carry hash prefixes, never values.
- `/__fake/accounts/<username>` shows the current password, TOTP secret, current code and passkey counters.
- `/__fake/captcha/latest` shows the answer to the latest challenge. `POST /__fake/reset` restores the seed accounts.
- Fake mail: `GET /__mail/messages?to=&from=&q=` and `/__mail/messages/<id>`. `/mcp` is the streamable-HTTP MCP server `fake_mail`, with the tools `search_messages` and `get_message`.

## Accounts

The defaults are `alice` (`alice@fake-login.test`) and `totp-user` (TOTP seed `JBSWY3DPEHPK3PXP`); their passwords are in `server.ts`. `FAKE_LOGIN_ACCOUNTS_JSON` replaces the defaults and `FAKE_LOGIN_EXTRA_ACCOUNTS_JSON` adds to them. Live 1Password mode (E2E-7) passes the real test login this way, in that process's environment only.

Proof run: `bun scripts/run-browser-e2e.ts ./test/e2e/secrets-fake-login-suite.browser.e2e.ts`. For a headed run, set `FAKE_LOGIN_HEADED=1` and use `xvfb-run -a`.
