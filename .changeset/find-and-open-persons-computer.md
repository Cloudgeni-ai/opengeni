---
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
"@opengeni/runtime": patch
---

Agents now find and open any of the person's computers in one call.

- interaction_discover lists the person's Connected Machines this chat can use (`machines`: name, OS, online state, whether it has a screen, the placement to open it with, and which one the chat is on). The model's view leaves out browser and computer sessions on machines that are offline or no longer usable, and says how many it left out; Code Mode still receives every record.
- computer_open and browser_open with a Connected Machine placement the chat is not on move the chat there first, exactly as sandbox_swap would, instead of failing and asking for a separate swap. A personal machine whose owner has not allowed the chat yet shows the card to allow that machine in the same call. Both tools now run in model order with the other calls of a response, like sandbox_swap.
- tool_search loads a tool by its exact name without the server prefix (`sandboxes_list` loads `opengeni__sandboxes_list`).
- An agent's swap and machine list through the API act for the person who started its turn, as sandbox_swap and sandboxes_list do, so that person's Only me machines are in reach. An agent attempt may list its own chat's machines with the session read permission sandboxes_list needs.
- A computer or browser request while the chat's current machine is offline or no longer usable is a 409 that says so, not a 500. Asking for another machine in that state gets the wrong-placement answer.
