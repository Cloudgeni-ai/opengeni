# The rail's folded group is called More

The rail's folded group (Get started, Capabilities, Automations, Knowledge,
Artifacts, Meetings) is renamed from "Setup" to "More". The
`sidebar_layout_update` tool description names it the same way; the option ids
(`setup`, `navSetup`) are unchanged, so saved layouts and existing calls keep
working:

> …, with setup standing for the folded More group, …

The Apps page's New app chat now starts with "Create an app: " instead of
"Create a workspace site: ", the word people see for these on the page.

Why it is general: the model should call the group what the person sees, so
"move Knowledge out of More" maps to `navSetup`.

Size: 1 byte less in sessions whose tools include `sidebar_layout_update`; no
other prompt text changes.
