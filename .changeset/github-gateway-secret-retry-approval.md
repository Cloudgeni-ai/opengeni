---
"@opengeni/api-router": patch
---

An approved `gh secret set` through Your GitHub is no longer held for approval again when the agent runs the same command after the approval. `gh` seals the secret value with fresh randomness on every run, and the gateway bound approvals to the exact body bytes, so the retry never matched. Secret writes (`PUT …/secrets/{name}` for repository, environment, organization, Dependabot and Codespaces secrets) now bind the approval to everything except `encrypted_value` and `key_id`; the method, path (repository, environment, secret name) and remaining fields such as visibility must still match, and the approval stays limited to the same session and turn and runs once. Other requests stay bound to their exact bytes.
