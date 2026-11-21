# Parallel tool calls example (OPENGENI_EXPERIMENT_TOOL_EFFICIENCY)

With the tool-efficiency setting on, requests ask for parallel tool calls and
the existing first rule under "Rules for getting work done" (modular base
behavior and legacy contract alike) gains an example:

```diff
- Run independent tool calls in parallel to save round trips.
+ Run independent tool calls in parallel to save round trips, for example reading several files or running independent searches in one response.
```

Why it is general: almost every task starts by reading several files or
running several searches whose inputs do not depend on each other; naming
those two common cases makes the existing rule concrete without mentioning
any task, language or tool.

Size: 92 bytes more in every system prompt while the setting is on; nothing
changes with it off. The text depends only on the deployment setting, so a
session's prompt never changes within the session.
