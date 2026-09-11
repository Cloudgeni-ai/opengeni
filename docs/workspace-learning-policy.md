# Historical workspace learning policy

Maintenance migration 0459 freezes this former policy authority for historical
accepted-attempt proof. New work uses [Agent learning](knowledge.md#agent-learning-settings):
separate Knowledge, workspace instruction and Skill categories with workspace or
personal defaults and sparse per-chat or per-scheduled-task overrides.

The old `workspace_learning_policy_revisions`, heads, activation events and
snapshots retain immutable historical policy and source exceptions. Those
exceptions do not configure new work. The cutover maps the former workspace
mode into instruction and Skill defaults, and explicit Memory opt-outs into
Knowledge Off. Already accepted legacy confirmations retain their exact proof;
new proposals use native destination lifecycles.

Current policy resolves from the accepted logical turn or scheduled run and is
frozen in `agent_learning_snapshots`. Children, continuations and replacement
attempts retain the causal producer policy. Changing a setting affects later
accepted work, never an in-flight attempt. Source content, collection membership,
pending findings and task notes cannot activate or override that policy.

Automatic publishes an authorized agent change, Review first stores an inactive
revision without interrupting the chat, and Off refuses agent authoring while
existing authorized retrieval remains available. Human editing and plugin
installation remain separate permissions. Review is a publication decision, not
an additional tool approval prompt. See [review and corrections](knowledge.md#review-and-corrections).

Original lifecycle/lock-order details remain in migrations 0199 and 0364 and the
pre-0459 fixtures. Do not restore their retired runtime authoring routes.
