---
"@opengeni/sdk": patch
"@opengeni/api-router": patch
---

Voice conversations now pass on what the person said instead of writing their own task for the agent. The voice model is told to relay requests in the person's own words and language, without adding tools, methods or details they didn't say, and to answer directly when the answer is already in the conversation. Each voice request the agent receives now notes that it was relayed and that the person's own words in the transcript take precedence over the relay.
