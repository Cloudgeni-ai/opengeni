# Historical Memory storage

Maintenance migration 0459 replaces the former Memory retrieval and authoring
system with [Knowledge and Agent learning](knowledge.md). Use that document for
all new integrations, agent tools, storage, review and UI behavior.

`knowledge_memories` and its former relationship/lifecycle tables remain
immutable historical evidence. They are not a live retrieval corpus or a write
destination. The conversion preserves exact content, stable entry IDs, restrictive
scope selectors, relationships, source references and lifecycle snapshots in
canonical Knowledge. Unknown ownership is not converted into shared authority.
Original schema and lifecycle details remain in the pre-0459 SQL migrations and
migration test fixtures.

Legacy `memoryScope` is a compatibility field on session creation. `user` selects
Knowledge owned by the verified initiating human; `workspace` selects shared
Knowledge. `off` initializes Knowledge authoring to Off, while existing authorized
Knowledge remains retrievable. Task notes handle temporary session-tree work;
new integrations cannot choose the retired session Memory scope. An opaque
end-user label never establishes personal ownership.

Conversation history, pending tool receipts, recovery state and temporary task
notes remain separate from Knowledge. See [run lifecycle](run-lifecycle.md) and
[task notes](company-brain-write-routing.md#root-task-tree-notes). Retained facts
never become prompt-composed instructions merely because an agent saved them.
