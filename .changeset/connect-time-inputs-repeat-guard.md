---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/core": patch
"@opengeni/api-router": patch
"@opengeni/react": minor
"@opengeni/runtime": patch
---

Connect cards can ask for connect-time inputs. An integration whose connections each need a value first (Microsoft Dynamics: the environment's address) declares those inputs in `@opengeni/contracts/capability-connect-inputs`. `capability_authorization_request` and tool discovery now post its Connect card, which asks the person for the value in one field with one Connect action, instead of answering `input_required` with no card. The agent can prefill a value with the tool's new `inputs` argument; it is used only when it follows the entry's rule. Catalog matches list the inputs as `setup.connectInputs`, the card payload carries them as `capability.inputs`, and capability creation takes `connectFor` so the API applies the same rule to what the person entered.

A runtime guard stops repeated identical tool calls. Once one exact call has returned the same result 8 times in a row in a turn, an identical call started within 30 seconds of the last one returns a short notice instead of running, and the run continues. Calls whose results change, and polling slower than 30 seconds, are unaffected.
