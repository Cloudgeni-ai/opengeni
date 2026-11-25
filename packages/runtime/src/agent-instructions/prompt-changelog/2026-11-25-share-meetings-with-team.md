# meetings_search names meetings shared from members' Personal workspaces

The `meetings_search` tool description gains one clause, so the model knows
that meetings "shared with the workspace" include those a member shared from
their Personal workspace. The modular prompt and the legacy contract are
unchanged, so no `diff` line is needed:

> Find recorded meetings the person you act for can see: those shared with the
> workspace (including from members' Personal workspaces) and their own, …

Why it is general: a member can now share a meeting recorded in their Personal
workspace with one of their team workspaces, read only. Those meetings are
stored elsewhere, so without the clause the model has no reason to look for
them when asked about a teammate's customer meeting.

Size: 46 bytes more, only in sessions whose tools include `meetings_search`.
It is part of the tool list, so those sessions pay one cold prompt prefix
after deploy and nothing changes within a session.
