---
"@opengeni/browserd": patch
---

An agent can now keep a secret a site shows once, such as an API key or client secret in a password field. Copying a password or one-time-code field to the browser clipboard works, and reading the browser clipboard shows the copied value, so the agent can save it to the vault. Before, the copy was refused and every way of reading the value back showed `[secret]`, so the secret was lost. Page reads and observations still withhold password fields, secrets the agent typed from a secret reference stay hidden in clipboard reads, and payment and private fields still cannot be copied.
