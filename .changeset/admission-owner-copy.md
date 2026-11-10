---
"@opengeni/react": minor
"@opengeni/react-native": patch
---

The machine owner's notice for a blocked message now reads consistently. In a paused chat it says, in one line, "Allow it for this chat. Your message starts when the chat is resumed." It no longer says "starts right away" next to a separate paused note. In a chat shared with the workspace, it also says that people in the workspace will see what the agent does on the machine, because allowing it there shares the machine for that chat. `sessionAdmissionMachineAccessCopy` accepts `paused` and `shared` options.
