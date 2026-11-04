---
"@opengeni/api-router": patch
---

Continue with Google or GitHub signs in or creates the account from either the Sign in or Sign up tab, and from the add-account window without a Create a new account switch. Each click runs the Turnstile signup challenge in the background and shows it inline only when Cloudflare asks for interaction. A social start whose challenge token can't be verified no longer fails: an existing user signs in, and creating a new user still requires a verified challenge.
