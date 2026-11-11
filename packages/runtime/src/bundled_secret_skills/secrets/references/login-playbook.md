# Login playbook

You sign in yourself. Work through the ladder in `SKILL.md` and use this file
for the details. None of these steps needs the user's permission.

## 1. Reuse a saved session

- If a browser identity exists for the site (`browser_identity` list), open
  the browser with it; you may already be signed in.
- If a site-auth connection is configured for the site, `browser_auth` can
  start and verify a provider login (`advance_external` for an external
  provider). If it returns `needs_human`, continue down the ladder before
  handing anything over.
- After any successful login, save the session with `browser_publish` so the
  next task starts signed in.

## 2. Sign in with a saved login

1. `secret_search {website: "github.com"}` (or `query`). Use the returned
   references exactly; `username` and `hasTotp` tell you what to expect.
2. Observe the page, then fill the form with references. A batch is fine:
   `fill` the username field with `{{secret:GitHub/username}}` and the
   password field with `{{secret:GitHub}}`, then submit.
3. At a code prompt, type `{{secret:GitHub/otp}}`. The code is computed when
   the action runs; when less than about three seconds remain in its window,
   delivery waits for the next code, so a slow page is not a problem.
4. Split code boxes and inputs that block paste: use `type` with
   `mode: "keys"` so each character is a key press.
5. Desktop apps work the same way: `computer_act` typing resolves references.

Multi-step forms (username first, then password) are normal: fill, continue,
observe, fill again. "Remember this device" is usually worth ticking.

## 3. Codes by email or SMS

- Trigger the code, then read it through the user's connected mail tools
  (Gmail, Outlook) or messaging tools. Search for the newest message from the
  service after the moment you triggered it, and type the code you find.
- Magic links: open the link in the same browser session you are signing in
  with.
- If no mail or messaging tool is connected and the code goes to the user,
  ask with a secret card (`fieldKind: "text"` or `concealed`,
  `autocomplete: "one-time-code"`, `saveTo: "task"`).

## CAPTCHAs and verification challenges

CAPTCHAs are always yours to solve; never hand one to the user.

- Take a screenshot and read the challenge; image grids, distorted text,
  sliders and rotate puzzles are all solvable with careful observation.
- Use the audio alternative when the visual one is hard.
- Reload the challenge or the page for an easier one, slow down between
  actions, and retry. Several attempts are normal.
- "Press and hold" and checkbox challenges: perform the action, then observe
  again.
- If one route keeps failing, try another: a different login method on the
  same site (email code instead of password), or the site's API with a key.

## When the login fails

- Wrong password: the password may have changed. Try
  `{{secret:Item#previous}}` once, then reset it through the site's email
  flow if you can read the mail: save the new password with `secret_save`
  (`generate`, `mode: "update"`) before submitting the reset form.
- Locked or rate-limited account: wait as the site says; do not hammer it.
- A push approval on the user's phone or a hardware key: this is the only
  case for `interaction_request_human` (headed browser, concise reason).
