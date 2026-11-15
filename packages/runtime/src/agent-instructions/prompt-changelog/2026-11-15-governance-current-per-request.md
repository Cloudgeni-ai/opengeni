# Workspace governance is current for every model request

No system-prompt text changes. The workspace governance history item
(`<opengeni_workspace_governance>`) changes in two ways.

Its lead sentence no longer says that governance is fixed for the turn,
because a turn now picks up governance activated while it waited or ran
(-1 byte):

```text
- Active workspace governance for this turn follows. Apply it after the non-bypassable CORE and in the section order shown. Later activations apply from a later turn.
+ Active workspace governance follows. Apply it after the non-bypassable CORE and in the section order shown. A later activation arrives as a newer governance block.
- Active organization and workspace governance for this turn follows. Apply it after the non-bypassable CORE and in the section order shown. Later activations apply from a later turn.
+ Active organization and workspace governance follows. Apply it after the non-bypassable CORE and in the section order shown. A later activation arrives as a newer governance block.
```

A turn whose attempt sees other governance than the newest governance item
in its history (it waited for capacity, recovered, or a policy or the
organization profile was activated between two of its model requests) gets
the current governance as a new item at the end of its history, before its
next request. Earlier items are not changed. Before, the item was frozen when
the turn first saw it and a change reached the model only at the next turn.

Because the lead sentence changed, every session with governance gets one new
governance item at its next turn.
