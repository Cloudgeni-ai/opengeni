---
"@opengeni/react": patch
---

Projects you collapse in the chat list stay collapsed after a reload. The app remembers the collapsed projects and groups per person and workspace on that device. New projects still open by default, and moving a chat into a collapsed project still opens it. The new `useCollapsedSessionSections` hook in the app's browse preferences holds this state.
