---
"@opengeni/react": patch
---

`AutomationsPanel` rows read as one line, "Every day at 07:30 · Oslo · Next run: Tomorrow, 07:30", that truncates once instead of twice. On a phone-width panel a row shows only its next run, or the events it waits for. `automations.panel.next` now reads "Next run: {time}".
