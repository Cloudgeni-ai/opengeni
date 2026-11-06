---
"@opengeni/runtime": patch
"@opengeni/codemode": patch
"@opengeni/worker-bundle": patch
"@opengeni/api-router": patch
---

The agent's own texts no longer name the product, so an agent that a host gives its own identity presents only that identity. The `privacy_facts` result says "this deployment" and "Request settings" instead of naming Opengeni, and the provider table describes requests in the passive voice ("Chat turns ask Azure not to store …"); every privacy, model and provider fact is unchanged. Three system-prompt clauses (secret references, GitHub app repositories, the GitHub app in integration setup) say "built-in workspace tools" and "the workspace's GitHub app". The `wait_for_input` and `goal_complete` descriptions say "the runtime", the GitHub, secret-profile, scheduled-trigger and Slack-suggestion descriptions drop the name, the Connected Machine descriptions and the setup-card description name the deployment's configured browser extension, and tool results such as workspace-machine faults, owned-box repairs, cross-workspace refusals and the secret-approval reply use the passive voice. The default identity, tool names, provenance markers such as `[Opengeni setup notice]`, and names of software a person installs are unchanged.
