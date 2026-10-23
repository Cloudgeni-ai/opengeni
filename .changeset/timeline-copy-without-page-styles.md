---
"@opengeni/react": patch
---

Text selected and copied from the conversation timeline no longer carries the app's styling. Browsers copy a selection's rich text with the page's computed colours, fonts and the surrounding message's background inlined, so pasting into a document or chat brought the timeline's dark or tinted backgrounds along. The timeline now copies its selection as clean semantic HTML (paragraphs, lists, emphasis, code, links, tables and images keep their structure) together with the browser's own plain text. Selections inside editable fields and outside the timeline keep the browser's default copy.
