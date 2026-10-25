---
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
"@opengeni/runtime": patch
"@opengeni/contracts": patch
"@opengeni/sdk": patch
---

Agents now find and open any of the person's computers in one call.

- interaction_discover lists the person's Connected Machines this chat can use (`machines`: name, OS, online state, whether it has a screen, the placement to open it with, and which one the chat is on). The model's view leaves out browser and computer sessions on machines listed as offline, and says how many it left out; Code Mode still receives every record.
- computer_open and browser_open with a Connected Machine placement the chat is not on move the chat there first, exactly as sandbox_swap would, instead of failing and asking for a separate swap, and the result says the chat moved. A personal machine whose owner has not allowed the chat yet shows the card to allow that machine in the same call. An open that names a Connected Machine placement runs in model order with the other calls of a response, like sandbox_swap; other opens still run in parallel.
- tool_search loads a tool by its exact name without the server prefix (`sandboxes_list` loads `opengeni__sandboxes_list`). When several servers share that name, Opengeni's own tool (else the first) loads and the others are listed as suggestions.
- An agent's swap and machine list through the API act for the person who started its turn when it moves or lists its own chat, as sandbox_swap and sandboxes_list do, so that person's Only me machines are in reach. Repointing another chat it may control works as before. An agent attempt may list its own chat's machines with the session read permission sandboxes_list needs.
- Moving a chat to a machine that has not reported its workspace root (or with an invalid working directory) is a typed refusal from the swap API, not a 500.
- A computer or browser request while the chat's current machine is offline or no longer usable is a 409 that says so, not a 500. Asking for another machine in that state gets the wrong-placement answer.
