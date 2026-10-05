---
"@opengeni/react": patch
---

A GitHub organization member who isn't an owner now gets a clear path instead of a dead end. Opengeni explains that an organization owner must approve and lets them send the request through GitHub. Afterward they see a calm "Waiting for your GitHub organization owner" state, and the GitHub card updates on its own once an owner connects the organization. An organization owner who approves on GitHub lands on a page explaining the one remaining step instead of an expired-link error. Published `.patch` and `.diff` files now have a "Copy command to apply these changes" button. It copies one `curl … | git apply` command that uses the existing short-lived authenticated download link, which expires in 5 minutes. `ConnectSetup` shows the owner-approval state, and `RetainedArtifactLoader` accepts an optional `{ prefer: "url" }`.
