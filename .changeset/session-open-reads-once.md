---
"@opengeni/sdk": patch
"@opengeni/react": patch
"@opengeni/react-native": patch
---

Opening a conversation reads each resource once, and reopening a recently viewed one draws at once.

- Session, queue, lineage, goal and human-input reads now report the session sequence they reflect (`X-OpenGeni-Session-Sequence`), so the shared event feed's opening burst no longer re-reads what the first read already covers. Opening one conversation drops from 11 requests (16 inside `OpenGeniProvider`) to 7 (8 with the provider's contract check). Older servers that do not send the header keep the previous refresh behaviour.
- `OpenGeniProvider` no longer runs its reconnect repair on the first open of a conversation; reconnects still repair every view.
- When the host retains reads (`OpenGeniProvider retainReadsAcrossMounts` or the new `useRetainedReads(client)`), reopening a conversation draws its last timeline, details, queue, goal, lineage and open questions from memory on the first render and refreshes behind it, with no spinner. Retained conversations are kept in memory only, per client object, within the event-browser byte budget; the composer draft is always read fresh.
- Workspace-scoped client config reads join one request per client and workspace (`readClientConfig`).
