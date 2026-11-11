---
"@opengeni/react": minor
"@opengeni/react-native": patch
---

The machine owner's notice for a blocked message now reads consistently. In a paused chat it says, in one line, "Allow it for this chat. It starts when the chat is resumed." It no longer says "starts right away" next to a separate paused note. In a chat shared with the workspace, it also says that people in the workspace will see what the agent does on the machine, because allowing it there shares the machine for that chat. `sessionAdmissionMachineAccessCopy` accepts `paused` and `shared` options. The notice no longer says "Your message is saved" in any state, since the message is already visible in the chat. A chat that moved to a machine it can use now shows a single line: "It starts by itself on the new machine." The permission notice now says who can fix it before saying that it starts by itself, and the machine-access lines drop "right now" and "You can".
