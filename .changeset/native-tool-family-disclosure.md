---
"@opengeni/runtime": patch
---

When an agent opens a browser or computer, the tools it can now use reach the model as an honest declaration instead of a made-up tool_search call. The declaration follows the step's results: an `additional_tools` item on Responses (Codex and OpenAI), and a system message with the definitions on Claude and Chat Completions, or a machine-origin user message on Gemini routes, which move system messages. The tools can be called by name or through tool_invoke. Claude and Chat no longer need the request-time pass that kept a step's results together, so it is removed. browser_act shows its locator and batch item once instead of three times, which cuts a browser declaration by about a third. Existing chats take one prompt-cache miss when they switch.
