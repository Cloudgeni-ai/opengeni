---
"@opengeni/sdk": patch
"@opengeni/api-router": patch
---

Voice conversations now pass on what the person said instead of writing their own task for the agent. The voice model is told to relay requests in the person's own words and language, without adding tools, methods or details they didn't say, and to answer directly when the answer is already in the conversation. Each voice request the agent receives now notes that it was relayed and that the person's own words in the transcript take precedence over the relay.

A voice call that reconnects no longer loses track of things. What was said since the last request carries over to the next request after a reconnect or a same-browser reload. The agent's progress and results for a request made before the reconnect reach the voice model as session context, labelled as work requested earlier in the call, instead of being sent to a conversation item the new connection doesn't have and being dropped. The voice model is also told to pass instructions on to the agent rather than answer them with a promise, and never to state a result, status, name, number or time the agent hasn't reported.
