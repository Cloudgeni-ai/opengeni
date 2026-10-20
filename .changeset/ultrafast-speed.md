---
"@opengeni/contracts": minor
"@opengeni/config": minor
"@opengeni/codex": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/react-native": minor
---

Adds the Ultrafast speed for GPT-6 Astra and GPT-6.1 Sol. When a model offers it, the model picker replaces the Fast toggle with a Speed choice (Standard, Fast, Ultrafast) and shows what the faster speeds cost: 8× usage on a ChatGPT/Codex plan, or the rate multiple on metered routes. A Codex account offers Ultrafast only when its own model list advertises the tier, so the picker shows it only when some account serving the workspace can run it, and an Ultrafast turn is placed only on such an account. Ultrafast requests use `service_tier: "ultrafast"`, and a response served at a lower tier is not counted as Ultrafast. Turns accepted before a model declared Ultrafast keep running unchanged.
