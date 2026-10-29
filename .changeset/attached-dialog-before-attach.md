---
"@opengeni/browserd": patch
---

In the person's own Chrome, a tab whose page opened a dialog (alert, confirm or prompt) while no agent was controlling it no longer hangs every call for two minutes and then reports the tab as not responding. Chrome lets no extension read or answer such a dialog, so browserd dismisses it once the way Chrome does for a tab sent to the background (the page sees Cancel; the person sees their tab switch away and back for a moment) and tells the agent once in the observation's notice. Dialogs the page opens after that show in observations and `handle_dialog` answers them. Page commands in attached Chrome now time out after 30 seconds and attaching after 10 seconds, instead of waiting without a limit.
