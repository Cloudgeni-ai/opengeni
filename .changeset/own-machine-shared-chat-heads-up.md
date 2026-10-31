---
"@opengeni/react": patch
---

When a chat shared with the workspace runs on your own personal machine, a one-line heads-up above the composer now says so: people in this workspace see what the agent does on it. "Use another machine" opens the same machine picker to move the chat. Your private chats, and chats in your Personal workspace, show nothing. `SessionMachineAccessNotice` takes `shared` and `className` for this, and `SessionMachinePickerAction` takes `compact` for the small trigger.
