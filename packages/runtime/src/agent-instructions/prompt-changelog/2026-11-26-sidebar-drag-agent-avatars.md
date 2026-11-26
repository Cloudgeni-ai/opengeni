# sidebar_layout_update names the rail entry order options

The `sidebar_layout_update` tool description gains the two new personal
navigation options, `navOrder` and `navSetup`, so the model can reorder the
built-in rail entries when a person asks ("put Apps above Inbox", "take
Knowledge out of Setup"). The modular prompt and the legacy contract are
unchanged, so no `diff` line is needed:

> …, and navOrder and navSetup (the built-in rail entries in order: navOrder
> lists the top-level entry ids, with setup standing for the folded Setup
> group, and navSetup the ids inside that group; ids are the hiddenNavEntries
> ones plus new_session and page names such as insights or settings;
> new_session and inbox stay at the top level; entries left out keep their
> place).

Why it is general: people can now drag any rail entry to a new place, and the
order is stored in their personal sidebar layout. Without the clause the model
can't make the same change through the tool, or knows only the ids it can hide.

Size: 365 bytes more, only in sessions whose tools include
`sidebar_layout_update`. It is part of the tool list, so those sessions pay one
cold prompt prefix after deploy and nothing changes within a session.
