# Connected connectors in the connector availability notice

No system-prompt text changes. The per-turn "Connector availability" notice
(and the "Accounts that need reconnecting" notice when it stands alone) gains
one closing line naming the chat's connectors that are connected for this
turn: selected MCP connectors and routed API integrations, leaving out those
already reported unavailable, selections narrowed to no tools, and connectors
whose every routed account stopped working (they stay in the reconnect list).
A name equal to one named above carries its ID, as the unavailable entries
do. The line appears only on turns that already carry the notice: 166 bytes
plus the quoted names, at most 16 names, the rest counted. It does not promise
tools, because the connectors' tools are listed after the notice is written.

```text
+ Connected for this turn: "<name>", "<name>" (their tools may appear only through tool search). A connector the person names may be one of these rather than a similarly named one above.
```

Why it is general: the notice named only the connectors a turn runs
without. When the connected connector's tools were deferred behind tool
search, the first request said nothing about it, so the only connector of
that kind the model saw was the unavailable one. A production run asked for
one calendar service, saw another calendar service listed as having no
signed-in account, and answered that the requested one was unavailable
without calling tool search. The new line states which connectors are usable
for every connector and every request; it names no task, person or
integration.
