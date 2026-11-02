---
"@opengeni/react": minor
---

Slack agent pages: creating, editing and introducing an agent keep the page gutter instead of touching the sidebar, the icon is a button next to the name that opens the picker, and editing links the agent's Memory in Knowledge. Create now works when the Opengeni bot loads after the form opened, and says why it can't when no Slack workspace is connected. Deleting an agent says its Memory stays. New `SessionAvatarPickerButton`; the avatar picker's kind switch and icon grid no longer stretch across the form.
