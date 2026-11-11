---
"@opengeni/react": minor
"@opengeni/react-native": patch
---

The blocked-message notice reads more simply.

- A paused machine owner gets one line, "Allow it for this chat. Your message starts when the chat is resumed.", instead of "starts right away" next to a separate paused note.
- When other people in the workspace can see the chat (workspace visibility, outside a Personal workspace), the owner learns that allowing the machine lets them see what the agent does on it. On web the composer's shared-machine heads-up steps aside while this shows.
- "Your message is saved" is gone from every state, since the message is already in the chat. After the chat moves to a machine it can use, the notice shows "Starting on the new machine" and "Your message starts by itself."
- The permission line says who can fix it, then that the message starts by itself. The machine-access lines drop "right now" and "You can".

API changes:

- `SessionAdmissionNotice` takes `sharedChat`, and `useSessionStart` returns `sharedChat`, read from the workspace kind through `getWorkspace` when the client has it.
- `sessionAdmissionMachineAccessCopy` accepts `paused` and `shared` options.
- New message keys: `sessionAdmission.machineAccessOwnerPausedNext`, `sessionAdmission.machineAccessOwnerSettingsPausedNext` and `sessionAdmission.machineAccessSharedNote`. `sessionAdmission.machineChangedBody` is removed; drop it from custom translations.
- `sessionAdmissionMachineChangedCopy` now returns an empty `next`. Skip rendering an empty `next`.
