---
"@opengeni/react": patch
"@opengeni/sdk": patch
"@opengeni/codex": patch
---

Send never does nothing without saying why. The new chat and open chat composers share one Send guard; whenever it blocks Send and no other notice already explains it, one short line under the composer says why, with at most one action. A model choice whose reasoning level or speed the account can't run (for example a saved Ultrafast speed after connecting a ChatGPT Free account, which offers GPT-6 Luna only) shows "This model can't run with the selected reasoning level or speed." with "Use supported settings". When an unavailable model is replaced automatically, the speed now follows the replacement. A Codex refusal of a model the ChatGPT account can't use ("not supported when using Codex with a ChatGPT account", or "Model not found") is now treated as a plan refusal: that account skips the model for a while and the chat shows the plan error. Connecting a Codex account now lists the Opengeni models it offers, and warns when it offers none (`CodexConnectPoll.models`).
