---
"@opengeni/capabilities": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Gmail search, thread and draft-list results now reach the model as compact mail cards (sender, recipients, date, subject, labels, attachment names and the start of the body, with `contentTruncated` when cut), sized to the current model's tool-output budget, so a 50-message full-content search is about 47 KB of model-visible text instead of a 3.5 MB result that had to spill to a file. `get_message` stays complete but drops the HTML body when a plain-text body exists, and replaces an HTML-only body that does not fit the budget with its readable text. Codemode and the spill file still receive the exact results. Local MCP bridges can supply such a model-only copy through the new optional `projectModelToolResult` hook. A spilled tool result's receipt now gives its shell path whenever the attempt has a sandbox route, including a sandbox that has not started yet, because every sandbox start copies the attempt's spilled files before its first operation; it is `null` only without a sandbox route or after a failed copy.
