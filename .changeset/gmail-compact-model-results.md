---
"@opengeni/capabilities": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Gmail search, thread and draft-list results now reach the model as compact mail cards (sender, recipients, date, subject, labels, attachment names and the start of the body, with `contentTruncated` when cut), sized to the current model's tool-output budget, so a 50-message full-content search is about 47 KB of model-visible text instead of a 3.5 MB result that had to spill to a file. `get_message` stays complete but drops the HTML body when a plain-text body exists, and replaces an HTML-only body that does not fit the budget with its readable text. Codemode and the spill file still receive the exact results. Local MCP bridges can supply such a model-only copy through the new optional `projectModelToolResult` hook. Cards keep a Reply-To that names another address than the sender. A spilled tool result that arrives before the turn's lazy sandbox has started now starts it and copies the file, so its receipt gives the shell path instead of `null`; the path is given only once the copy is really there.
