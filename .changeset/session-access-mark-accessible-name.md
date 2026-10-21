---
"@opengeni/react": patch
---

Screen readers now read the session header's read-only access mark ("Workspace session access. Visible to people in …") and the Private mark for Personal workspace chats. Both were focusable spans with an `aria-label` but no role, which ARIA does not allow, so assistive technology could skip the label.
