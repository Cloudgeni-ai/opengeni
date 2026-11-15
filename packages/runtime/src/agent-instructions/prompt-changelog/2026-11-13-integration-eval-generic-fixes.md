# Discovery cards from listings, connection listings and Slack channel names

No system-prompt text changes. One tool-description sentence and some tool
result texts change.

The Slack tools' `channel` parameter description (+38 bytes) now says it also
takes a channel name, which the tool resolves:

```text
- Slack conversation ID, such as C123 or D123.
+ Slack conversation ID, such as C123 or D123, or a channel name such as #general.
```

Its invalid-input error, and four new errors for a name that cannot be
resolved:

```text
- channel must be a Slack conversation ID
+ channel must be a Slack conversation ID or a channel name such as #general
+ No channel named #<name> is visible to this Slack account. Check the name, or find the channel and its ID with slack_list_channels.
+ Several channels are named #<name> (<ids>). Pass the conversation ID of the one you mean.
+ #<name> is not among the first channels this Slack account can see. Pass its conversation ID instead; slack_list_channels lists channels with their IDs.
+ Slack has not granted access to look up #<name> by name. Pass the channel's conversation ID instead.
```

A `tool_list` `namePrefix` that is one aliased MCP tool's digest now lists that
tool's whole connection, and the result says why (new `message`, 89 bytes):

```text
+ namePrefix is one tool's own digest, so this lists every tool of that tool's connection.
```

An empty filtered `tool_list` page whose filter names one connectable
integration now carries the existing `tool_search` `notConnected` notice and
`connectCard` field, with unchanged text.

All are general: they describe what a parameter accepts, why a value failed,
or what a listing contains, for any connection, integration, model or route.
